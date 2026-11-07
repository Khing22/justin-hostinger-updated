const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { app, sessions, products, orders, saleRecords, returns, suppliers, users } = require('../server');

const originalState = {
  products: JSON.parse(JSON.stringify(products)),
  orders: JSON.parse(JSON.stringify(orders)),
  saleRecords: JSON.parse(JSON.stringify(saleRecords)),
  returns: JSON.parse(JSON.stringify(returns || [])),
  users: [{
    id: 2,
    name: 'Test Staff',
    email: 'staff@example.test',
    passwordHash: 'test-fixture-no-login',
    role: 'Staff'
  }]
};

function resetState() {
  products.splice(0, products.length, ...JSON.parse(JSON.stringify(originalState.products)));
  orders.splice(0, orders.length, ...JSON.parse(JSON.stringify(originalState.orders)));
  saleRecords.splice(0, saleRecords.length, ...JSON.parse(JSON.stringify(originalState.saleRecords)));
  returns.splice(0, returns.length, ...JSON.parse(JSON.stringify(originalState.returns || [])));
  users.splice(0, users.length, ...JSON.parse(JSON.stringify(originalState.users)));
}

test.beforeEach(() => {
  resetState();
});

async function request(path, cookie = 'stockpro_session=demo-session') {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { Cookie: cookie }
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('orders page renders the transaction table', async () => {
  const result = await request('/orders');
  assert.equal(result.status, 200);
  assert.match(result.text, /Transactions/i);
  assert.match(result.text, /Transaction ID/i);
});

test('orders page has no transactions after records are cleared', async () => {
  orders.splice(0, orders.length);
  assert.equal(orders.length, 0);

  const result = await request('/orders');
  assert.equal(result.status, 200);
  const tableBody = result.text.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  assert.ok(tableBody);
  assert.doesNotMatch(tableBody[1], /<tr>/i);
});

test('administrator can clear all saved transaction records', async () => {
  saleRecords.push({ id: 'TRX-TEST', amount: 100 });
  returns.push({ id: 'RET-TEST', amount: 100 });

  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/orders/clear`, {
      method: 'POST',
      headers: { Cookie: 'stockpro_session=demo-session' },
      redirect: 'manual'
    });

    assert.equal(response.status, 302);
    assert.equal(orders.length, 0);
    assert.equal(saleRecords.length, 0);
    assert.equal(returns.length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('sales dashboard refreshes its sales figures daily without deleting history', async () => {
  await new Promise(resolve => setTimeout(resolve, 1200));

  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  sessions.set('daily-sales-session', {
    id: 2,
    name: 'Sales User',
    email: 'sales@adisl.com',
    password: 'sales123',
    role: 'Staff'
  });
  saleRecords.splice(0, saleRecords.length, ...[
    {
      id: 'TODAY-SALE',
      amount: 1500,
      paymentMethod: 'Card',
      date: now.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' }),
      timestamp: now.toISOString(),
      items: [{ name: 'Current Product', quantity: 3, price: 500, total: 1500 }],
      createdBy: 2
    },
    {
      id: 'YESTERDAY-SALE',
      amount: 9000,
      paymentMethod: 'Card',
      date: yesterday.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' }),
      timestamp: yesterday.toISOString(),
      items: [{ name: 'Previous Product', quantity: 9, price: 1000, total: 9000 }],
      createdBy: 2
    }
  ]);

  const result = await request('/', 'stockpro_session=daily-sales-session');

  assert.equal(result.status, 200);
  assert.match(result.text, /₦1,500/);
  assert.match(result.text, /₦10,500/, 'other sales summaries should continue using all-time figures');
  assert.match(result.text, /Current Product/);
  assert.match(result.text, /Previous Product/, 'historical sales should remain in the dashboard history views');
  assert.equal(saleRecords.length, 2, 'historical sales should remain stored');
});

test('staff members only see their own transaction records', async () => {
  sessions.set('sales-user-session', {
    id: 2,
    name: 'Sales User',
    email: 'sales@adisl.com',
    password: 'sales123',
    role: 'Staff'
  });

  sessions.set('other-sales-session', {
    id: 99,
    name: 'Other Sales User',
    email: 'other@adisl.com',
    password: 'other123',
    role: 'Staff'
  });

  orders.splice(0, orders.length, ...[
    { id: 'TX-100', customer: 'Alice', amount: 1000, status: 'Completed', paymentMethod: 'Card', date: '01 Jan 2026', time: '09:00 AM', reference: 'INV-100', createdBy: 2 },
    { id: 'TX-101', customer: 'Bob', amount: 2000, status: 'Completed', paymentMethod: 'Cash', date: '02 Jan 2026', time: '10:00 AM', reference: 'INV-101', createdBy: 99 },
    { id: 'TX-102', customer: 'Charlie', amount: 3000, status: 'Completed', paymentMethod: 'Card', date: '03 Jan 2026', time: '11:00 AM', reference: 'INV-102' }
  ]);

  const result = await request('/orders', 'stockpro_session=sales-user-session');

  assert.equal(result.status, 200);
  assert.match(result.text, /TX-100/i);
  assert.doesNotMatch(result.text, /TX-101/i);
  assert.doesNotMatch(result.text, /TX-102/i);
});

test('admin transaction table identifies the staff member for each sale', async () => {
  orders.splice(0, orders.length, {
    id: 'TX-ADMIN-100',
    customer: 'Walk-in customer',
    amount: 5000,
    status: 'Completed',
    paymentMethod: 'Cash',
    date: '04 Jan 2026',
    time: '12:00 PM',
    reference: 'INV-ADMIN-100',
    createdBy: 2
  });

  const result = await request('/orders');

  assert.equal(result.status, 200);
  assert.match(result.text, /Staff/i);
  assert.match(result.text, /Sales User/i);
});

test('orders download endpoint returns CSV transaction export', async () => {
  orders.push({
    id: 'TRX-EXPORT-100',
    customer: 'Export test customer',
    amount: 1200,
    status: 'Completed',
    paymentMethod: 'Card',
    date: '05 Oct 2026',
    time: '09:00 AM',
    reference: 'INV-EXPORT-100'
  });

  const result = await request('/orders/download');
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-type') || '', /text\/csv|application\/csv/i);
  assert.match(result.text, /Transaction ID,Customer,Amount/i);
  assert.match(result.text, /TRX-EXPORT-100/);
});

test('supplier management supports create, edit and delete', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  try {
    const beforeCount = suppliers.length;
    const createResponse = await fetch(`http://127.0.0.1:${port}/suppliers/create`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=demo-session'
      },
      body: new URLSearchParams({
        name: 'Bright Supply',
        email: 'hello@brightsupply.com',
        phone: '+234 809 876 5432',
        products: '7'
      })
    });

    assert.equal(createResponse.status, 302);
    assert.equal(suppliers.length, beforeCount + 1);
    const created = suppliers.find(item => item.name === 'Bright Supply');
    assert.ok(created, 'supplier was not created');

    const editResponse = await fetch(`http://127.0.0.1:${port}/suppliers/${created.id}/edit`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=demo-session'
      },
      body: new URLSearchParams({
        name: 'Bright Supply Co',
        email: 'sales@brightsupplyco.com',
        phone: '+234 810 111 2222',
        products: '9'
      })
    });

    assert.equal(editResponse.status, 302);
    assert.equal(created.name, 'Bright Supply Co');
    assert.equal(created.email, 'sales@brightsupplyco.com');

    const deleteResponse = await fetch(`http://127.0.0.1:${port}/suppliers/${created.id}/delete`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=demo-session'
      }
    });

    assert.equal(deleteResponse.status, 302);
    assert.ok(!suppliers.some(item => item.id === created.id));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('GET supplier edit URL redirects to the editable supplier page', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/suppliers/1/edit`, {
      redirect: 'manual',
      headers: { Cookie: 'stockpro_session=demo-session' }
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/suppliers?edit=1');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('newly created users remain saved with existing accounts', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const beforeCount = users.length;
  const uniqueEmail = `newuser-${Date.now()}@example.com`;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/users/create`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=demo-session'
      },
      body: new URLSearchParams({
        name: 'New Team User',
        email: uniqueEmail,
        password: 'welcome-password-1234',
        role: 'Staff'
      })
    });

    assert.equal(response.status, 302);
    assert.equal(users.length, beforeCount + 1);
    const createdUser = users.find(user => user.email === uniqueEmail);
    assert.ok(createdUser);
    assert.match(createdUser.passwordHash, /^scrypt\$/);
    assert.equal(Object.hasOwn(createdUser, 'password'), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('admin can reset and remove a staff account', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const staff = users.find(user => user.role === 'Staff');

  try {
    const resetResponse = await fetch(`http://127.0.0.1:${port}/users/${staff.id}/reset-password`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=demo-session'
      },
      body: new URLSearchParams({ password: 'new-staff-password' })
    });

    assert.equal(resetResponse.status, 302);
    assert.match(staff.passwordHash, /^scrypt\$/);
    assert.equal(Object.hasOwn(staff, 'password'), false);

    const deleteResponse = await fetch(`http://127.0.0.1:${port}/users/${staff.id}/delete`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: 'stockpro_session=demo-session' }
    });

    assert.equal(deleteResponse.status, 302);
    assert.ok(!users.some(user => user.id === staff.id));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('admin dashboard keeps inventory overview', async () => {
  const result = await request('/');
  assert.equal(result.status, 200);
  assert.match(result.text, /Dashboard/i);
  assert.match(result.text, /Items Listed|Total Products/i);
});

test('admin dashboard uses live inventory for top stocked products', async () => {
  const result = await request('/');
  assert.equal(result.status, 200);
  assert.match(result.text, /Laptop|Running Shoes|Backpack|Smart Watch|Water Bottle/i);
  assert.doesNotMatch(result.text, /T-Shirt|Jeans|Sneakers|Cap/i);
});

test('staff dashboard shows sales overview instead of admin inventory', async () => {
  sessions.set('sales-user-session', {
    id: 2,
    name: 'Sales User',
    email: 'sales@adisl.com',
    password: 'sales123',
    role: 'Staff'
  });

  const result = await request('/', 'stockpro_session=sales-user-session');
  assert.equal(result.status, 200);
  assert.match(result.text, /Sales Overview|Sales Dashboard/i);
  assert.match(result.text, /Today Sales|Items Sold|Cash Sales/i);
});

test('record sale updates stock and adds a transaction', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  try {
    const target = products.find(product => product.id === 1);
    const beforeStock = target.stock;

    const response = await fetch(`http://127.0.0.1:${port}/sales/record`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=sales-user-session'
      },
      body: new URLSearchParams({
        productId: '1',
        quantity: '2',
        customer: 'Jane Smith',
        paymentMethod: 'Card'
      })
    });

    assert.equal(response.status, 302);
    assert.match(response.headers.get('location') || '', /\?sale=success/);
    assert.equal(target.stock, beforeStock - 2);

    const latestSale = saleRecords[0];
    assert.ok(latestSale);
    assert.ok(latestSale.date);
    assert.ok(latestSale.time);
    assert.match(latestSale.time, /\d{1,2}:\d{2}/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('staff sales appear in the admin dashboard and all transactions', async () => {
  await new Promise(resolve => setTimeout(resolve, 1200));
  sessions.set('admin-sales-visibility-session', {
    id: 2,
    name: 'Sales User',
    email: 'sales@adisl.com',
    password: 'sales123',
    role: 'Staff'
  });
  if (!users.some(user => Number(user.id) === 2)) {
    users.push({
      id: 2,
      name: 'Sales User',
      email: 'sales@adisl.com',
      password: 'sales123',
      role: 'Staff'
    });
  }

  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  try {
    if (!products.length) {
      products.push({
        id: 1,
        name: 'Visibility Test Product',
        category: 'Test',
        supplier: 'Test Supplier',
        price: 100,
        stock: 10,
        icon: '📦'
      });
    }
    const product = products[0];
    product.stock = Math.max(Number(product.stock) || 0, 10);
    const saleResponse = await fetch(`http://127.0.0.1:${port}/sales/record`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=admin-sales-visibility-session'
      },
      body: new URLSearchParams({
        productId: String(product.id),
        quantity: '1',
        paymentMethod: 'Cash'
      })
    });

    assert.equal(saleResponse.status, 302);
    assert.match(saleResponse.headers.get('location') || '', /\?sale=success/);
    const transactionId = saleRecords[0].id;

    const dashboardResponse = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Cookie: 'stockpro_session=demo-session' }
    });
    const dashboardHtml = await dashboardResponse.text();
    assert.equal(dashboardResponse.status, 200);
    assert.ok(dashboardHtml.includes(transactionId), 'today’s sale should appear in the admin dashboard');

    const transactionsResponse = await fetch(`http://127.0.0.1:${port}/orders`, {
      headers: { Cookie: 'stockpro_session=demo-session' }
    });
    const transactionsHtml = await transactionsResponse.text();
    assert.equal(transactionsResponse.status, 200);
    assert.ok(transactionsHtml.includes(transactionId), 'sale should appear in the full admin transaction history');
    assert.ok(transactionsHtml.includes('Sales User'), 'admin transaction history should identify the selling staff member');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('sales records keep exact timestamps and persist on shutdown', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const dataFile = path.join(__dirname, '..', 'data', 'store.json');
  const previousExit = process.exit;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/sales/record`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=sales-user-session'
      },
      body: new URLSearchParams({
        productId: '1',
        quantity: '1',
        paymentMethod: 'Card'
      })
    });

    assert.equal(response.status, 302);
    const latestSale = saleRecords[0];
    assert.ok(latestSale);
    assert.ok(latestSale.timestamp, 'timestamp should be stored for exact time tracking');
    assert.match(latestSale.time, /\d{2}:\d{2}:\d{2}/, 'timestamp should include seconds');
    assert.match(latestSale.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    process.exit = () => {};
    process.emit('SIGINT');

    const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.ok(Array.isArray(persisted.saleRecords));
    assert.ok(persisted.saleRecords.some(record => record.id === latestSale.id));
  } finally {
    process.exit = previousExit;
    await new Promise(resolve => server.close(resolve));
  }
});

test('sales dashboard includes product list and cart summary', async () => {
  sessions.set('sales-user-session', {
    id: 2,
    name: 'Sales User',
    email: 'sales@adisl.com',
    password: 'sales123',
    role: 'Staff'
  });

  const result = await request('/', 'stockpro_session=sales-user-session');
  assert.equal(result.status, 200);
  assert.match(result.text, /Cart/i);
  assert.match(result.text, /Total/i);
  assert.match(result.text, /Add/i);
});

test('staff products page behaves like the sales catalog with live products and cart', async () => {
  sessions.set('sales-user-session', {
    id: 2,
    name: 'Sales User',
    email: 'sales@adisl.com',
    password: 'sales123',
    role: 'Staff'
  });

  const result = await request('/products', 'stockpro_session=sales-user-session');
  assert.equal(result.status, 200);
  assert.match(result.text, /Products/i);
  assert.match(result.text, /Cart/i);
  assert.match(result.text, /Search products/i);
  assert.match(result.text, /Laptop/i);
});

test('stock change indicators show when stock is added or reduced', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const product = products.find(item => item.id === 1);

  try {
    const before = product.stock;
    const saleResponse = await fetch(`http://127.0.0.1:${port}/sales/record`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=sales-user-session'
      },
      body: new URLSearchParams({ productId: '1', quantity: '1', paymentMethod: 'Cash' })
    });
    assert.equal(saleResponse.status, 302);
    assert.ok(product.lastStockChange < 0, 'sale should mark a negative stock change');

    const page = await fetch(`http://127.0.0.1:${port}/products`, {
      headers: { Cookie: 'stockpro_session=sales-user-session' }
    });
    const text = await page.text();
    assert.match(text, /-1|Stock/i);
    assert.equal(product.stock, before - 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('recorded sales keep every sold item and products page supports search', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  const before = saleRecords.length;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/sales/record`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=sales-user-session'
      },
      body: new URLSearchParams({
        productId: '1',
        quantity: '1',
        customer: 'Search Buyer',
        paymentMethod: 'Cash'
      })
    });

    assert.equal(response.status, 302);
    assert.ok(saleRecords.length > before, 'sale record was not created');
    assert.ok(saleRecords[0].items.some(item => item.name === 'Laptop'));

    const productPage = await fetch(`http://127.0.0.1:${port}/products`, {
      headers: { Cookie: 'stockpro_session=demo-session' }
    });
    const productText = await productPage.text();
    assert.match(productText, /Search products/i);
    assert.match(productText, /Laptop/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('checkout records multiple sold items and reduces stock for each item', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const target = products.find(item => item.id === 1);
  const beforeStock = target.stock;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/sales/record`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=sales-user-session'
      },
      body: new URLSearchParams({
        paymentMethod: 'Card',
        items: JSON.stringify([
          { productId: 1, quantity: 2 },
          { productId: 2, quantity: 1 }
        ])
      })
    });

    assert.equal(response.status, 302);
    assert.equal(target.stock, beforeStock - 2);
    assert.ok(saleRecords[0].items.some(item => item.name === 'Laptop'));
    assert.ok(saleRecords[0].items.some(item => item.name === 'Running Shoes'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('transactions hide customer names from the sales views', async () => {
  const result = await request('/orders');
  assert.equal(result.status, 200);
  assert.doesNotMatch(result.text, /<th>Customer<\/th>/i);
  assert.doesNotMatch(result.text, /Customer/i);
});

test('product stock controls add and remove stock items correctly', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const product = products.find(item => item.id === 1);
  const before = product.stock;

  try {
    const addResponse = await fetch(`http://127.0.0.1:${port}/products/1/stock`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=demo-session'
      },
      body: new URLSearchParams({ action: 'add', quantity: '2' })
    });
    assert.equal(addResponse.status, 302);
    assert.equal(product.stock, before + 2);

    const removeResponse = await fetch(`http://127.0.0.1:${port}/products/1/stock`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=demo-session'
      },
      body: new URLSearchParams({ action: 'remove', quantity: '1' })
    });
    assert.equal(removeResponse.status, 302);
    assert.equal(product.stock, before + 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('sale records persist to disk so data survives a restart', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const dataFile = path.join(__dirname, '..', 'data', 'store.json');

  try {
    const response = await fetch(`http://127.0.0.1:${port}/sales/record`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=sales-user-session'
      },
      body: new URLSearchParams({
        productId: '1',
        quantity: '1',
        paymentMethod: 'Cash'
      })
    });

    assert.equal(response.status, 302);
    assert.ok(fs.existsSync(dataFile), 'data file was not created');

    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.ok(Array.isArray(saved.saleRecords));
    assert.ok(saved.saleRecords.some(item => item.amount > 0));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('saved product changes survive logout and reload instead of reverting to defaults', async () => {
  const dataFile = path.join(__dirname, '..', 'data', 'store.json');
  const original = fs.existsSync(dataFile) ? fs.readFileSync(dataFile, 'utf8') : null;
  let freshServer;

  try {
    fs.writeFileSync(dataFile, JSON.stringify({
      products: [{ id: 1, name: 'Persistent test product', price: 100, stock: 5 }],
      orders: [],
      saleRecords: []
    }, null, 2));
    delete require.cache[require.resolve('../server')];
    const freshModule = require('../server');
    freshServer = freshModule.app.listen(0);
    await new Promise(resolve => freshServer.once('listening', resolve));
    const { port } = freshServer.address();
    const updateResponse = await fetch(`http://127.0.0.1:${port}/products/1/stock`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=demo-session'
      },
      body: new URLSearchParams({ action: 'add', quantity: '1' })
    });
    assert.equal(updateResponse.status, 302);

    const logoutResponse = await fetch(`http://127.0.0.1:${port}/logout`, {
      headers: { Cookie: 'stockpro_session=demo-session' },
      redirect: 'manual'
    });
    assert.equal(logoutResponse.status, 302);
    assert.equal(freshModule.products[0].stock, 6);

    delete require.cache[require.resolve('../server')];
    const reloadedModule = require('../server');
    assert.equal(reloadedModule.products[0].stock, 6);
  } finally {
    if (original === null) {
      if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
    } else {
      fs.writeFileSync(dataFile, original);
    }
    if (freshServer && freshServer.listening) {
      await new Promise(resolve => freshServer.close(resolve));
    }
    delete require.cache[require.resolve('../server')];
    require('../server');
  }
});

test('top selling products come from real sales and return records are stored', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  try {
    saleRecords.splice(0, saleRecords.length, [
      {
        id: 'TX-RETURN-1',
        customer: 'A',
        amount: 2000,
        paymentMethod: 'Card',
        status: 'Completed',
        date: 'Sep 09, 2026',
        time: '09:00 AM',
        reference: 'INV-1001',
        items: [
          { id: 1, name: 'Laptop', quantity: 2, price: 1000, total: 2000 },
          { id: 2, name: 'Running Shoes', quantity: 1, price: 300, total: 300 }
        ]
      },
      {
        id: 'TX-RETURN-2',
        customer: 'B',
        amount: 1000,
        paymentMethod: 'Cash',
        status: 'Completed',
        date: 'Sep 09, 2026',
        time: '10:00 AM',
        reference: 'INV-1002',
        items: [
          { id: 1, name: 'Laptop', quantity: 1, price: 1000, total: 1000 }
        ]
      }
    ]);

    const page = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Cookie: 'stockpro_session=sales-user-session' }
    });
    const html = await page.text();
    assert.match(html, /Laptop/i);
    assert.match(html, /3 sold/i);

    const beforeReturns = Array.isArray(saleRecords) ? saleRecords.length : 0;
    const response = await fetch(`http://127.0.0.1:${port}/returns/record`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'stockpro_session=sales-user-session'
      },
      body: new URLSearchParams({
        itemName: 'Laptop',
        quantity: '1',
        amount: '1000',
        reason: 'Damaged upon delivery'
      })
    });

    assert.equal(response.status, 302);
    assert.ok(Array.isArray(saleRecords));
    assert.ok(beforeReturns >= 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('returned items are listed and downloadable in Word format', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  try {
    returns.splice(0, returns.length, [{
      id: 'RET-1001',
      itemName: 'Laptop',
      quantity: 1,
      amount: 1000,
      reason: 'Damaged upon delivery',
      date: 'Sep 09, 2026',
      time: '10:00 AM',
      status: 'Returned',
      createdBy: 2
    }]);

    const dashboard = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Cookie: 'stockpro_session=sales-user-session' }
    });
    const dashboardText = await dashboard.text();
    assert.match(dashboardText, /Laptop/i);
    assert.match(dashboardText, /Returned items/i);

    const doc = await fetch(`http://127.0.0.1:${port}/returns/download`, {
      headers: { Cookie: 'stockpro_session=sales-user-session' }
    });
    const contentType = doc.headers.get('content-type') || '';
    const content = await doc.text();
    assert.ok(/msword|vnd\.ms-word|application\/doc|word/i.test(contentType) || /Laptop/i.test(content));
    assert.match(content, /Laptop/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

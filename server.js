require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const multer = require("multer");
const mysql = require("mysql2/promise");
const ExcelJS = require("exceljs");

const app = express();
const configuredPort = process.env.PORT || process.env.WEB_PORT || 8080;
const PORT = Number.parseInt(configuredPort, 10);
const HOST = process.env.HOST || "0.0.0.0";
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`Invalid port "${configuredPort}". PORT must be between 1 and 65535.`);
}
const sessions = new Map();
const dataDirectory = path.join(__dirname, "data");
const uploadDirectory = path.join(dataDirectory, "uploads");
const legacyUploadDirectory = path.join(__dirname, "public", "uploads");
fs.mkdirSync(uploadDirectory, { recursive: true });
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const allowedTypes = new Map([
      [".jpg", "image/jpeg"],
      [".jpeg", "image/jpeg"],
      [".png", "image/png"],
      [".webp", "image/webp"]
    ]);
    if (allowedTypes.get(extension) !== file.mimetype) {
      return callback(new Error("Only PNG, JPEG, and WebP images are allowed."));
    }
    callback(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});
const dataFilePath = path.join(dataDirectory, "store.json");
fs.mkdirSync(dataDirectory, { recursive: true });
const passwordHashPrefix = "scrypt";
const passwordHashCost = 16384;
const passwordHashBlockSize = 8;
const passwordHashParallelization = 1;
const loginAttempts = new Map();
const loginWindowMs = 15 * 60 * 1000;
const maxLoginAttempts = 10;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, {
      N: passwordHashCost,
      r: passwordHashBlockSize,
      p: passwordHashParallelization,
      maxmem: 64 * 1024 * 1024
    }, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(`${passwordHashPrefix}$${passwordHashCost}$${passwordHashBlockSize}$${passwordHashParallelization}$${salt.toString("hex")}$${derivedKey.toString("hex")}`);
    });
  });
}

function isPasswordHash(value) {
  return typeof value === "string" &&
    new RegExp(`^${passwordHashPrefix}\\$${passwordHashCost}\\$${passwordHashBlockSize}\\$${passwordHashParallelization}\\$[a-f\\d]{32}\\$[a-f\\d]{128}$`).test(value);
}

function verifyPassword(password, encodedHash) {
  if (!isPasswordHash(encodedHash)) return Promise.resolve(false);
  const [, , , , saltHex, expectedHex] = encodedHash.split("$");
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, expected.length, {
      N: passwordHashCost,
      r: passwordHashBlockSize,
      p: passwordHashParallelization,
      maxmem: 64 * 1024 * 1024
    }, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(crypto.timingSafeEqual(derivedKey, expected));
    });
  });
}

function getImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: ".png", contentType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: ".jpg", contentType: "image/jpeg" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { extension: ".webp", contentType: "image/webp" };
  }
  if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
    return { extension: ".ico", contentType: "image/x-icon" };
  }
  return null;
}

function saveUploadedImage(req, res, next) {
  if (!req.file) return next();
  const imageType = getImageType(req.file.buffer);
  if (!imageType) return res.status(400).send("The uploaded file is not a supported image.");

  const filename = `${Date.now()}-${crypto.randomBytes(12).toString("hex")}${imageType.extension}`;
  fs.writeFile(path.join(uploadDirectory, filename), req.file.buffer, { flag: "wx" }, error => {
    if (error) return next(error);
    req.uploadedImagePath = `/uploads/${filename}`;
    next();
  });
}

function handleImageUpload(req, res, next) {
  upload.single("image")(req, res, error => {
    if (error) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).send(error.message);
    }
    saveUploadedImage(req, res, next);
  });
}

const bulkUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (extension !== ".xlsx") {
      return callback(new Error("Only .xlsx Excel files are supported."));
    }
    callback(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

function buildExactTimestamps(date = new Date()) {
  const iso = date.toISOString();
  const displayDate = date.toLocaleDateString("en-NG", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
  const displayTime = date.toLocaleTimeString("en-NG", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });

  return {
    timestamp: iso,
    date: displayDate,
    time: displayTime
  };
}

function isToday(record) {
  if (record && record.timestamp) {
    const recordDate = new Date(record.timestamp);
    if (!Number.isNaN(recordDate.getTime())) {
      return recordDate.toDateString() === new Date().toDateString();
    }
  }

  return record && record.date === buildExactTimestamps().date;
}

const defaultProducts = [
  { id: 1, inventoryId: "INV-1001", name: "Laptop", category: "Electronics", supplier: "Dell Supplies", price: 250000, colour: "Silver", stock: 50, icon: "💻", lastStockChange: 0 },
  { id: 2, inventoryId: "INV-1002", name: "Running Shoes", category: "Footwear", supplier: "Nike Ltd", price: 45000, colour: "Black", stock: 8, icon: "👟", lastStockChange: 0 },
  { id: 3, inventoryId: "INV-1003", name: "Backpack", category: "Bags", supplier: "Global Traders", price: 25000, colour: "Blue", stock: 30, icon: "🎒", lastStockChange: 0 },
  { id: 4, inventoryId: "INV-1004", name: "Smart Watch", category: "Electronics", supplier: "Tech World", price: 80000, colour: "Black", stock: 15, icon: "⌚", lastStockChange: 0 },
  { id: 5, inventoryId: "INV-1005", name: "Water Bottle", category: "Accessories", supplier: "Home Essentials", price: 12000, colour: "Green", stock: 45, icon: "🧴", lastStockChange: 0 }
];

const defaultOrders = [
  { id: "TRX1001", customer: "John Doe", amount: 45000, status: "Completed", paymentMethod: "Card", date: "Apr 27, 2025", time: "09:45 AM", reference: "INV-2041" },
  { id: "TRX1002", customer: "Sarah Johnson", amount: 32500, status: "Completed", paymentMethod: "Transfer", date: "Apr 26, 2025", time: "11:20 AM", reference: "INV-2039" },
  { id: "TRX1003", customer: "Michael Brown", amount: 78000, status: "Pending", paymentMethod: "Wallet", date: "Apr 25, 2025", time: "03:10 PM", reference: "INV-2035" },
  { id: "TRX1004", customer: "Grace Wilson", amount: 15600, status: "Completed", paymentMethod: "Card", date: "Apr 24, 2025", time: "08:55 AM", reference: "INV-2031" },
  { id: "TRX1005", customer: "David Kim", amount: 92000, status: "Refunded", paymentMethod: "Bank", date: "Apr 23, 2025", time: "06:40 PM", reference: "INV-2028" }
];

const defaultSuppliers = [
  { id: 1, name: "Dell Supplies", email: "sales@dellsupplies.com", phone: "+234 801 234 5678", products: 24 },
  { id: 2, name: "Nike Ltd", email: "orders@nikeltd.com", phone: "+234 802 345 6789", products: 18 },
  { id: 3, name: "Global Traders", email: "hello@globaltraders.com", phone: "+234 803 456 7890", products: 31 },
  { id: 4, name: "Tech World", email: "support@techworld.com", phone: "+234 804 567 8901", products: 27 }
];

const defaultUsers = [];

function createDefaultStore() {
  return {
    products: [...defaultProducts],
    orders: [...defaultOrders],
    saleRecords: [],
    returns: [],
    suppliers: [...defaultSuppliers],
    users: [...defaultUsers]
  };
}

function loadStore() {
  if (!fs.existsSync(dataFilePath)) return createDefaultStore();

  const parsed = JSON.parse(fs.readFileSync(dataFilePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid data store format in ${dataFilePath}.`);
  }

  const loadedProducts = Array.isArray(parsed.products) ? parsed.products : [...defaultProducts];
  loadedProducts.forEach((product, index) => {
    if (!String(product.inventoryId || "").trim()) {
      product.inventoryId = `INV-${1001 + index}`;
    }
    if (!String(product.colour || "").trim()) product.colour = "";
  });

  return {
    products: loadedProducts,
    orders: Array.isArray(parsed.orders) ? parsed.orders : [...defaultOrders],
    saleRecords: Array.isArray(parsed.saleRecords) ? parsed.saleRecords : [],
    returns: Array.isArray(parsed.returns) ? parsed.returns : [],
    suppliers: Array.isArray(parsed.suppliers) ? parsed.suppliers : [...defaultSuppliers],
    users: Array.isArray(parsed.users) ? parsed.users : [...defaultUsers]
  };
}

const users = [...defaultUsers];
if (process.env.NODE_ENV === "test") {
  sessions.set("demo-session", { id: 1, name: "Test Administrator", role: "Administrator" });
}

const persistedStore = loadStore();
let products = persistedStore.products;
let orders = persistedStore.orders;
let saleRecords = persistedStore.saleRecords;
let returns = persistedStore.returns;
let suppliers = persistedStore.suppliers;
let usersState = persistedStore.users;
users.splice(0, users.length, ...usersState);
let setupRequired = false;

function buildDatabaseSslConfig() {
  if (String(process.env.DB_SSL || "true").toLowerCase() === "false") {
    return undefined;
  }

  const config = { rejectUnauthorized: true };
  if (process.env.DB_SSL_CA) {
    config.ca = fs.readFileSync(process.env.DB_SSL_CA, "utf8");
  }

  return config;
}

const DB_CONFIG = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "stockpro_local",
  ssl: buildDatabaseSslConfig()
};

let mysqlPool = null;
let useMysql = false;

async function ensureMysqlDatabase() {
  mysqlPool = mysql.createPool({
    ...DB_CONFIG,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  await mysqlPool.query("SELECT 1");
  useMysql = true;

  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGINT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(255),
      supplier VARCHAR(255),
      price DECIMAL(12,2) NOT NULL,
      stock INT NOT NULL,
      icon VARCHAR(20),
      image VARCHAR(255),
      lastStockChange INT DEFAULT 0
    )
  `);

  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(50) PRIMARY KEY,
      customer VARCHAR(255),
      amount DECIMAL(12,2) NOT NULL,
      paymentMethod VARCHAR(50),
      status VARCHAR(50),
      date VARCHAR(100),
      time VARCHAR(50),
      reference VARCHAR(100),
      createdBy BIGINT
    )
  `);
  await mysqlPool.query("ALTER TABLE orders ADD COLUMN createdBy BIGINT").catch(error => {
    if (error.code !== "ER_DUP_FIELDNAME") throw error;
  });

  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS sale_records (
      id VARCHAR(50) PRIMARY KEY,
      customer VARCHAR(255),
      amount DECIMAL(12,2) NOT NULL,
      paymentMethod VARCHAR(50),
      status VARCHAR(50),
      date VARCHAR(100),
      time VARCHAR(50),
      reference VARCHAR(100),
      items JSON
    )
  `);

  console.log("Connected to MySQL database.");
}

async function loadMysqlState() {
  if (!mysqlPool) return null;

  const [productRows] = await mysqlPool.query("SELECT * FROM products ORDER BY id ASC");
  const [orderRows] = await mysqlPool.query("SELECT * FROM orders ORDER BY id DESC");
  const [saleRows] = await mysqlPool.query("SELECT * FROM sale_records ORDER BY id DESC");

  return {
    products: productRows.map(row => ({
      ...row,
      price: Number(row.price),
      stock: Number(row.stock),
      lastStockChange: Number(row.lastStockChange || 0)
    })),
    orders: orderRows.map(row => ({
      ...row,
      amount: Number(row.amount),
      createdBy: row.createdBy === null ? null : Number(row.createdBy)
    })),
    saleRecords: saleRows.map(row => ({
      ...row,
      amount: Number(row.amount),
      items: Array.isArray(row.items) ? row.items : JSON.parse(row.items || "[]")
    })),
    returns: []
  };
}

async function persistMysqlState() {
  if (!mysqlPool) return;

  await mysqlPool.query("DELETE FROM products");
  await mysqlPool.query("DELETE FROM orders");
  await mysqlPool.query("DELETE FROM sale_records");

  if (products.length) {
    await mysqlPool.query(
      "INSERT INTO products (id, name, category, supplier, price, stock, icon, image, lastStockChange) VALUES ?",
      [products.map(product => [
        product.id,
        product.name,
        product.category || "",
        product.supplier || "",
        Number(product.price),
        Number(product.stock),
        product.icon || "📦",
        product.image || null,
        Number(product.lastStockChange || 0)
      ])]
    );
  }

  if (orders.length) {
    await mysqlPool.query(
      "INSERT INTO orders (id, customer, amount, paymentMethod, status, date, time, reference, createdBy) VALUES ?",
      [orders.map(order => [
        order.id,
        order.customer || "",
        Number(order.amount),
        order.paymentMethod || "",
        order.status || "Completed",
        order.date || "",
        order.time || "",
        order.reference || "",
        order.createdBy ?? null
      ])]
    );
  }

  if (saleRecords.length) {
    await mysqlPool.query(
      "INSERT INTO sale_records (id, customer, amount, paymentMethod, status, date, time, reference, items) VALUES ?",
      [saleRecords.map(record => [
        record.id,
        record.customer || "",
        Number(record.amount),
        record.paymentMethod || "",
        record.status || "Completed",
        record.date || "",
        record.time || "",
        record.reference || "",
        JSON.stringify(record.items || [])
      ])]
    );
  }
}

async function initializePersistence() {
  await prepareUserAccounts();
  try {
    if (process.env.NODE_ENV === "test") {
      if (!fs.existsSync(dataFilePath)) persistStore({ syncMysql: false });
      return;
    }

    await ensureMysqlDatabase();
    const mysqlState = await loadMysqlState();
    const hasMysqlData = mysqlState.products.length ||
      mysqlState.orders.length ||
      mysqlState.saleRecords.length;

    if (hasMysqlData) {
      products.splice(0, products.length, ...mysqlState.products);
      orders.splice(0, orders.length, ...mysqlState.orders);
      saleRecords.splice(0, saleRecords.length, ...mysqlState.saleRecords);
      persistStore({ syncMysql: false });
    } else {
      await persistMysqlState();
      if (!fs.existsSync(dataFilePath)) persistStore({ syncMysql: false });
    }
  } catch (error) {
    console.warn("MySQL unavailable, falling back to local JSON storage.", error.message);
    useMysql = false;
    mysqlPool = null;
    const fallback = loadStore();
    products.splice(0, products.length, ...fallback.products);
    orders.splice(0, orders.length, ...fallback.orders);
    saleRecords.splice(0, saleRecords.length, ...fallback.saleRecords);
    suppliers.splice(0, suppliers.length, ...fallback.suppliers);
  }

  if (!fs.existsSync(dataFilePath)) persistStore({ syncMysql: false });
}

function persistStore({ syncMysql = true } = {}) {
  syncSupplierProductCounts();
  usersState = [...users];
  const serializedStore = JSON.stringify({ products, orders, saleRecords, returns, suppliers, users }, null, 2);
  const temporaryFilePath = path.join(
    dataDirectory,
    `.store-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  let fileDescriptor;

  try {
    fileDescriptor = fs.openSync(temporaryFilePath, "wx");
    fs.writeFileSync(fileDescriptor, serializedStore, "utf8");
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.renameSync(temporaryFilePath, dataFilePath);
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        fs.closeSync(fileDescriptor);
      } catch (closeError) {
        console.error("Failed to close temporary stock data file.", closeError.message);
      }
    }
    try {
      fs.unlinkSync(temporaryFilePath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        console.error("Failed to remove temporary stock data file.", cleanupError.message);
      }
    }
    throw new Error(`Failed to persist stock data to ${dataFilePath}: ${error.message}`, { cause: error });
  }

  if (syncMysql && useMysql && mysqlPool) {
    persistMysqlState().catch(error => {
      console.warn("MySQL persist failed; local JSON data remains saved.", error.message);
      useMysql = false;
    });
  }
}

async function prepareUserAccounts() {
  const secureAccounts = users.filter(user => isPasswordHash(user.passwordHash));
  const invalidatedAccounts = users.length - secureAccounts.length;
  users.splice(0, users.length, ...secureAccounts);

  if (invalidatedAccounts > 0) {
    console.warn(`Invalidated ${invalidatedAccounts} account(s) that had no supported password hash. Recreate these accounts after administrator setup.`);
  }

  let administrator = users.find(user => user.role === "Administrator");
  if (!administrator) {
    const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const password = String(process.env.ADMIN_PASSWORD || "").trim();
    if (!email || !password || password.length < 12) {
      if (process.env.NODE_ENV === "test") {
        setupRequired = false;
        return;
      }
      setupRequired = true;
      return;
    }


    administrator = {
      id: Date.now(),
      name: String(process.env.ADMIN_NAME || "Administrator").trim(),
      email,
      passwordHash: await hashPassword(password),
      role: "Administrator"
    };
    users.push(administrator);
  }

  usersState = [...users];
}

function shutdownGracefully(signal) {
  const signalName = signal || "shutdown";
  try {
    persistStore();
    console.log(`Saved stock data before ${signalName}.`);
  } catch (error) {
    console.error(`Failed to save stock data before ${signalName}.`, error.message);
    if (process.env.NODE_ENV !== "test") process.exit(1);
    return;
  }
  if (process.env.NODE_ENV !== "test") process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, shutdownGracefully);
}

process.on("exit", () => {
  try {
    if (process.env.NODE_ENV !== "test") {
      persistStore();
    }
  } catch (error) {
    console.error("Exit persistence failed.", error.message);
  }
});

process.on("beforeExit", () => {
  try {
    if (process.env.NODE_ENV !== "test") {
      persistStore();
    }
  } catch (error) {
    console.error("Before-exit persistence failed.", error.message);
  }
});

const dataReady = initializePersistence();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/uploads", requireAuth, async (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return res.sendStatus(404);
  const filename = req.path.slice(1);
  if (!filename || path.basename(filename) !== filename || !/^[\w.-]+$/.test(filename)) {
    return res.sendStatus(404);
  }

  const extension = path.extname(filename).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp", ".ico"].includes(extension)) {
    return res.sendStatus(404);
  }

  let image;
  try {
    image = await fs.promises.readFile(path.join(uploadDirectory, filename));
  } catch (error) {
    if (error.code !== "ENOENT") return next(error);
    try {
      image = await fs.promises.readFile(path.join(legacyUploadDirectory, filename));
    } catch (legacyError) {
      if (legacyError.code === "ENOENT") return res.sendStatus(404);
      return next(legacyError);
    }
  }

  const imageType = getImageType(image);
  if (!imageType || (extension !== imageType.extension && !(extension === ".jpeg" && imageType.extension === ".jpg"))) {
    return res.sendStatus(404);
  }

  res.set({
    "Content-Type": imageType.contentType,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, max-age=3600"
  });
  res.send(image);
});
app.use(express.static(path.join(__dirname, "public")));
app.use(async (req, res, next) => {
  try {
    await dataReady;
    next();
  } catch (error) {
    next(error);
  }
});

function normalizeSupplierList(records) {
  if (!Array.isArray(records)) return [];
  return records.map((supplier, index) => ({
    id: supplier.id ?? index + 1,
    name: String(supplier.name || "").trim(),
    email: String(supplier.email || "").trim(),
    phone: String(supplier.phone || "").trim(),
    products: Number(supplier.products || 0)
  })).filter(supplier => supplier.name);
}

function normalizeCollection(records) {
  if (!Array.isArray(records)) return [];

  const flattened = [];
  for (const entry of records) {
    if (Array.isArray(entry)) {
      flattened.push(...normalizeCollection(entry));
    } else if (entry && typeof entry === "object") {
      flattened.push(entry);
    }
  }

  return flattened;
}

function normalizeState() {
  products.splice(0, products.length, ...normalizeCollection(products));
  orders.splice(0, orders.length, ...normalizeCollection(orders));
  saleRecords.splice(0, saleRecords.length, ...normalizeCollection(saleRecords));
  returns.splice(0, returns.length, ...normalizeCollection(returns));
  suppliers.splice(0, suppliers.length, ...normalizeSupplierList(suppliers));
}

function syncSupplierProductCounts() {
  const counts = new Map();

  for (const product of products) {
    const supplierName = String(product.supplier || "").trim();
    if (!supplierName) continue;
    counts.set(supplierName, (counts.get(supplierName) || 0) + 1);
  }

  for (const supplier of suppliers) {
    supplier.products = counts.get(supplier.name) || 0;
  }
}

function getVisibleRecords(req, records) {
  if (!req || !req.user || req.user.role === "Administrator") return records;
  const userId = Number(req.user.id);
  return (Array.isArray(records) ? records : []).filter(record => Number(record.createdBy) === userId);
}

function getTopSellingProducts(records, catalog = products) {
  const totals = new Map();

  for (const record of Array.isArray(records) ? records : []) {
    const items = Array.isArray(record.items) ? record.items : [];

    for (const item of items) {
      const name = String(item.name || "").trim();
      if (!name) continue;

      const quantity = Number(item.quantity || 0);
      const unitPrice = Number(item.price || 0);
      const revenue = Number(item.total || quantity * unitPrice);

      const existing = totals.get(name) || {
        name,
        quantity: 0,
        revenue: 0,
        image: null,
        icon: "📦"
      };

      existing.quantity += quantity;
      existing.revenue += revenue;

      const productMatch = (Array.isArray(catalog) ? catalog : []).find(product => product.name && product.name.toLowerCase() === name.toLowerCase());
      if (productMatch) {
        existing.image = productMatch.image || existing.image;
        existing.icon = productMatch.icon || existing.icon;
      }

      totals.set(name, existing);
    }
  }

  return [...totals.values()]
    .sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue)
    .slice(0, 5)
    .map(item => ({
      ...item,
      quantity: Number(item.quantity || 0),
      revenue: Number(item.revenue || 0)
    }));
}

function getStaffName(userId) {
  const staff = users.find(user => Number(user.id) === Number(userId));
  return staff ? staff.name : "Legacy / unknown";
}

const adminNavItems = [
  { label: "Dashboard", href: "/", icon: "grid" },
  { label: "Products", href: "/products", icon: "box" },
  { label: "Orders", href: "/orders", icon: "cart" },
  { label: "Suppliers", href: "/suppliers", icon: "truck" },
  { label: "Users", href: "/users", icon: "user" },
  { label: "Profile", href: "/profile", icon: "user" }
];

const salesNavItems = [
  { label: "Sales", href: "/", icon: "grid" },
  { label: "Products", href: "/products", icon: "box" },
  { label: "Transactions", href: "/orders", icon: "cart" },
  { label: "Profile", href: "/profile", icon: "user" }
];

app.locals.formatNaira = value =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0
  }).format(value);

function renderPage(req, res, view, data = {}) {
  const isAdmin = req.user && req.user.role === "Administrator";
  const currentUser = req.user || { name: "User", role: "Staff" };
  const safeReturns = Array.isArray(data.returns) ? data.returns : [];

  res.locals.currentUser = currentUser;
  res.locals.returns = safeReturns;
  res.render(view, {
    ...data,
    returns: safeReturns,
    currentPath: req.path,
    navItems: isAdmin ? adminNavItems : salesNavItems,
    isAdmin,
    currentUser
  });
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split("; ").filter(Boolean).map(cookie => {
    const separator = cookie.indexOf("=");
    return [cookie.slice(0, separator), decodeURIComponent(cookie.slice(separator + 1))];
  }));
}

function requireAuth(req, res, next) {
  const user = sessions.get(parseCookies(req).stockpro_session);
  if (user) {
    req.user = user;
    return next();
  }

  const redirect = encodeURIComponent(req.originalUrl);
  res.redirect(`/login?redirect=${redirect}`);
}

function getSafeRedirect(value) {
  if (typeof value !== "string") return "/";
  const redirect = value.trim();
  if (
    !redirect.startsWith("/") ||
    redirect.startsWith("//") ||
    redirect.includes("\\") ||
    /[\r\n]/.test(redirect)
  ) {
    return "/";
  }
  return redirect;
}

app.get("/login", (req, res) => {
  if (setupRequired) return res.redirect("/setup");
  const redirect = getSafeRedirect(req.query.redirect);
  if (sessions.has(parseCookies(req).stockpro_session)) {
    return res.redirect(redirect);
  }

  res.render("login", {
    title: "Sign in",
    redirect,
    error: null
  });
});


app.post("/login", async (req, res) => {
  const email = String(req.body.email || "Admin@adisl.com").trim().toLowerCase();
  const password = String(req.body.password || "Administarator@123");
  const redirect = getSafeRedirect(req.body.redirect);
  const attemptKey = req.ip;
  const now = Date.now();
  let attempt = loginAttempts.get(attemptKey);
  if (!attempt || attempt.resetAt <= now) {
    attempt = { count: 0, resetAt: now + loginWindowMs };
    loginAttempts.set(attemptKey, attempt);
  }
  if (attempt.count >= maxLoginAttempts) {
    return res.status(429).render("login", {
      title: "Sign in",
      redirect,
      error: "Too many sign-in attempts. Try again in 15 minutes."
    });
  }

  const user = users.find(account => String(account.email || "").toLowerCase() === email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    attempt.count += 1;
    return res.status(401).render("login", {
      title: "Sign in",
      redirect,
      error: "The email or password you entered is incorrect."
    });
  }

  loginAttempts.delete(attemptKey);
  const sessionId = crypto.randomBytes(24).toString("hex");
  sessions.set(sessionId, {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  });
  const secureCookie = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `stockpro_session=${sessionId}; HttpOnly; Path=/; SameSite=Lax${secureCookie}`);
  res.redirect(redirect);
});

app.get("/logout", (req, res) => {
  const cookies = parseCookies(req);
  sessions.delete(cookies.stockpro_session);
  const secureCookie = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `stockpro_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secureCookie}`);
  res.redirect("/login");
});

app.get("/setup", (req, res) => {
  if (!setupRequired) return res.redirect("/login");
  res.render("setup", {
    title: "Administrator setup",
    error: null
  });
});

app.post("/setup", async (req, res) => {
  if (!setupRequired) return res.redirect("/login");

  const name = String(req.body.name || "Administrator").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!name || !email || !email.includes("@") || password.length < 12) {
    return res.status(400).render("setup", {
      title: "Administrator setup",
      error: "Enter a name, valid email, and password of at least 12 characters."
    });
  }

  users.unshift({
    id: Date.now(),
    name,
    email,
    passwordHash: await hashPassword(password),
    role: "Administrator"
  });
  setupRequired = false;
  persistStore();
  res.redirect("/login");
});

app.use(requireAuth);

function requireAdmin(req, res, next) {
  if (req.user.role === "Administrator") return next();
  res.status(403).send("Access denied. This area is for administrators only.");
}

function requireSalesAccess(req, res, next) {
  if (req.user.role !== "Administrator") return next();
  res.status(403).send("Sales portal is only available to staff users.");
}

app.get("/", (req, res) => {
  normalizeState();

  if (req.user.role !== "Administrator") {
    const visibleSales = getVisibleRecords(req, saleRecords);
    const todaysSales = visibleSales.filter(isToday);
    const visibleOrders = getVisibleRecords(req, orders);
    const visibleReturns = getVisibleRecords(req, returns);

    const recentSales = [...visibleSales].slice(0, 5).map(record => ({
      item: Array.isArray(record.items) ? record.items.map(item => item.name).join(", ") : "—",
      amount: Number(record.amount || 0),
      time: record.date,
      payment: record.paymentMethod
    }));

    const totalRevenue = visibleSales.reduce((sum, record) => sum + Number(record.amount || 0), 0);
    const refundTotal = visibleReturns.reduce((sum, record) => sum + Number(record.amount || 0), 0);
    const itemsSold = todaysSales.reduce((sum, record) => sum + (Array.isArray(record.items) ? record.items.reduce((count, item) => count + Number(item.quantity || 0), 0) : 0), 0);
    const returnedItems = visibleReturns.reduce((sum, record) => sum + Number(record.quantity || 0), 0);
    const topSellingProducts = getTopSellingProducts(visibleSales, products);

    return renderPage(req, res, "sales-dashboard", {
      title: "Sales Dashboard",
      products,
      visibleSales,
      orders: visibleOrders,
      returns: visibleReturns,
      salesStats: {
        todaySales: todaysSales.reduce((sum, record) => sum + Number(record.amount || 0), 0),
        itemsSold,
        cashSales: todaysSales.filter(record => record.paymentMethod === "Card").reduce((sum, record) => sum + Number(record.amount || 0), 0),
        totalRevenue,
        refundTotal,
        returnedItems
      },
      topSellingProducts,
      recentSales,
      saleMessage: req.query.sale === "success" ? "Sale recorded successfully." : req.query.sale === "stock" ? "Not enough stock for that quantity." : null,
      saleTone: req.query.sale === "success" ? "success" : req.query.sale === "stock" ? "error" : null
    });
  }

  const todaysOrders = orders.filter(isToday);
  const soldProductNames = new Set(
    (Array.isArray(saleRecords) ? saleRecords : []).flatMap(record =>
      Array.isArray(record.items) ? record.items.map(item => String(item.name || "").trim().toLowerCase()).filter(Boolean) : []
    )
  );

  const liveLowStock = [...products]
    .filter(product =>
      Number(product.stock) >= 0 &&
      soldProductNames.has(String(product.name || "").trim().toLowerCase())
    )
    .sort((a, b) => Number(a.stock) - Number(b.stock) || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map(product => ({
      name: product.name,
      category: product.category,
      stock: Number(product.stock)
    }));

  const liveTopStocked = getTopSellingProducts(saleRecords, products)
    .slice(0, 5)
    .map(product => ({
      name: product.name,
      category: String(product.category || (products.find(item => item.name.toLowerCase() === String(product.name || "").toLowerCase())?.category || "Uncategorized")),
      stock: Number(product.quantity || 0),
      icon: product.icon || "📦",
      image: product.image || null
    }));

  const dashboardDate = new Date().toLocaleString("en-NG", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });

  const pageSize = 100;
  const productPage = Math.max(1, Number.parseInt(req.query.productPage, 10) || 1);
  const productTotalPages = Math.max(1, Math.ceil(products.length / pageSize));
  const currentProductPage = Math.min(productPage, productTotalPages);
  const productStart = (currentProductPage - 1) * pageSize;

  const orderPage = Math.max(1, Number.parseInt(req.query.orderPage, 10) || 1);
  const orderTotalPages = Math.max(1, Math.ceil(todaysOrders.length / pageSize));
  const currentOrderPage = Math.min(orderPage, orderTotalPages);
  const orderStart = (currentOrderPage - 1) * pageSize;

  renderPage(req, res, "dashboard", {
    title: "Dashboard",
    products: products.slice(productStart, productStart + pageSize),
    orders: todaysOrders.slice(orderStart, orderStart + pageSize),
    productPagination: {
      currentPage: currentProductPage,
      totalPages: productTotalPages,
      totalItems: products.length,
      startItem: products.length === 0 ? 0 : productStart + 1,
      endItem: Math.min(productStart + pageSize, products.length)
    },
    orderPagination: {
      currentPage: currentOrderPage,
      totalPages: orderTotalPages,
      totalItems: todaysOrders.length,
      startItem: todaysOrders.length === 0 ? 0 : orderStart + 1,
      endItem: Math.min(orderStart + pageSize, todaysOrders.length)
    },
    currentDateTime: dashboardDate,
    stats: {
      totalProducts: products.length,
      totalStocks: products.reduce((sum, product) => sum + product.stock, 0),
      totalOrders: todaysOrders.length,
      revenue: products.reduce((sum, product) => sum + (product.price * product.stock), 0)
    },
    lowStock: liveLowStock,
    topStocked: liveTopStocked
  });
});

app.get("/products", (req, res) => {
  normalizeState();

  if (req.user.role !== "Administrator") {
    const visibleSales = getVisibleRecords(req, saleRecords);
    const todaysSales = visibleSales.filter(isToday);
    const visibleOrders = getVisibleRecords(req, orders);
    const visibleReturns = getVisibleRecords(req, returns);

    const recentSales = [...visibleSales].slice(0, 5).map(record => ({
      item: Array.isArray(record.items) ? record.items.map(item => item.name).join(", ") : "—",
      amount: Number(record.amount || 0),
      time: record.date,
      payment: record.paymentMethod
    }));

    const totalRevenue = visibleSales.reduce((sum, record) => sum + Number(record.amount || 0), 0);
    const refundTotal = visibleReturns.reduce((sum, record) => sum + Number(record.amount || 0), 0);
    const itemsSold = todaysSales.reduce((sum, record) => sum + (Array.isArray(record.items) ? record.items.reduce((count, item) => count + Number(item.quantity || 0), 0) : 0), 0);
    const returnedItems = visibleReturns.reduce((sum, record) => sum + Number(record.quantity || 0), 0);
    const topSellingProducts = getTopSellingProducts(visibleSales, products);

    return renderPage(req, res, "sales-dashboard", {
      title: "Products",
      products,
      visibleSales,
      orders: visibleOrders,
      returns: visibleReturns,
      salesStats: {
        todaySales: todaysSales.reduce((sum, record) => sum + Number(record.amount || 0), 0),
        itemsSold,
        cashSales: todaysSales.filter(record => record.paymentMethod === "Card").reduce((sum, record) => sum + Number(record.amount || 0), 0),
        totalRevenue,
        refundTotal,
        returnedItems
      },
      topSellingProducts,
      recentSales,
      saleMessage: null,
      saleTone: null,
      catalogMode: true
    });
  }

  const pageSize = 100;
  const requestedPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const totalPages = Math.max(1, Math.ceil(products.length / pageSize));
  const currentPage = Math.min(requestedPage, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedProducts = products.slice(startIndex, startIndex + pageSize);

  renderPage(req, res, "products", {
    title: "Products",
    products: paginatedProducts,
    pagination: {
      currentPage,
      totalPages,
      pageSize,
      totalItems: products.length,
      startItem: products.length === 0 ? 0 : startIndex + 1,
      endItem: Math.min(startIndex + pageSize, products.length)
    },
    bulkImported: Number(req.query.bulkImported || 0),
    bulkSkipped: Number(req.query.bulkSkipped || 0)
  });
});

app.get("/orders", (req, res) => {
  const visibleOrders = getVisibleRecords(req, orders);
  const pageSize = 100;
  const requestedPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const totalPages = Math.max(1, Math.ceil(visibleOrders.length / pageSize));
  const currentPage = Math.min(requestedPage, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedOrders = visibleOrders.slice(startIndex, startIndex + pageSize);
  renderPage(req, res, "orders", {
    title: "Transactions",
    orders: paginatedOrders.map(order => ({ ...order, staffName: getStaffName(order.createdBy) })),
    pagination: {
      currentPage,
      totalPages,
      pageSize,
      totalItems: visibleOrders.length,
      startItem: visibleOrders.length === 0 ? 0 : startIndex + 1,
      endItem: Math.min(startIndex + pageSize, visibleOrders.length)
    }
  });
});

app.get("/orders/download", (req, res) => {
  const visibleOrders = getVisibleRecords(req, orders);
  const includeStaff = req.user.role === "Administrator";
  const rows = [
    ["Transaction ID", "Customer", "Amount", "Payment Method", "Status", ...(includeStaff ? ["Staff"] : []), "Date", "Time", "Reference"],
    ...visibleOrders.map(order => [
      order.id,
      order.customer,
      String(order.amount),
      order.paymentMethod,
      order.status,
      ...(includeStaff ? [getStaffName(order.createdBy)] : []),
      order.date,
      order.time || "",
      order.reference
    ])
  ];

  const csv = rows.map(row => row.map(value => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(",")).join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="transactions.csv"');
  res.send(csv);
});

function clearTransactions(req, res) {
  normalizeState();
  orders.splice(0, orders.length);
  saleRecords.splice(0, saleRecords.length);
  returns.splice(0, returns.length);
  persistStore();
  res.redirect("/orders?transactions=cleared");
}

app.post("/orders/clear", requireAdmin, clearTransactions);
app.post("/transactions/clear", requireAdmin, clearTransactions);

app.get("/returns/download", (req, res) => {
  normalizeState();
  const visibleReturns = getVisibleRecords(req, returns);
  const rows = [
    ["Return ID", "Item", "Quantity", "Amount", "Reason", "Date", "Time", "Status"],
    ...visibleReturns.map(record => [
      record.id,
      record.itemName,
      String(record.quantity || 0),
      String(record.amount || 0),
      record.reason || "",
      record.date,
      record.time || "",
      record.status || "Returned"
    ])
  ];

  const content = [
    "Return Record",
    "============",
    "",
    ...rows.map(row => row.join(" | ")),
    "",
    `Recorded returns: ${visibleReturns.length}`
  ].join("\n");

  res.setHeader("Content-Type", "application/msword");
  res.setHeader("Content-Disposition", 'attachment; filename="return-records.doc"');
  res.send(content);
});

app.get("/suppliers", requireAdmin, (req, res) => {
  normalizeState();
  syncSupplierProductCounts();
  const pageSize = 100;
  const requestedPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const totalPages = Math.max(1, Math.ceil(suppliers.length / pageSize));
  const currentPage = Math.min(requestedPage, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  renderPage(req, res, "suppliers", {
    title: "Suppliers",
    suppliers: suppliers.slice(startIndex, startIndex + pageSize),
    pagination: {
      currentPage,
      totalPages,
      totalItems: suppliers.length,
      startItem: suppliers.length === 0 ? 0 : startIndex + 1,
      endItem: Math.min(startIndex + pageSize, suppliers.length)
    }
  });
});

app.post("/suppliers/create", requireAdmin, (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim();
  const phone = String(req.body.phone || "").trim();
  const productsCount = Number(req.body.products || 0);

  if (!name || !email || !phone || suppliers.some(supplier => supplier.name.toLowerCase() === name.toLowerCase())) {
    return res.redirect("/suppliers");
  }

  suppliers.push({
    id: Date.now(),
    name,
    email,
    phone,
    products: Number.isFinite(productsCount) ? Math.max(0, productsCount) : 0
  });
  syncSupplierProductCounts();
  persistStore();
  res.redirect("/suppliers");
});

app.get("/suppliers/create", requireAdmin, (req, res) => {
  res.redirect("/suppliers");
});

app.get("/suppliers/:id/edit", requireAdmin, (req, res) => {
  const supplier = suppliers.find(item => item.id === Number(req.params.id));
  if (!supplier) return res.status(404).send("Supplier not found");
  res.redirect(`/suppliers?edit=${encodeURIComponent(supplier.id)}`);
});

app.post("/suppliers/:id/edit", requireAdmin, (req, res) => {
  const supplier = suppliers.find(item => item.id === Number(req.params.id));
  if (!supplier) return res.status(404).send("Supplier not found");

  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim();
  const phone = String(req.body.phone || "").trim();

  if (!name || !email || !phone) return res.redirect("/suppliers");

  const previousName = supplier.name;
  supplier.name = name;
  supplier.email = email;
  supplier.phone = phone;

  if (previousName !== name) {
    products.forEach(product => {
      if (product.supplier === previousName) {
        product.supplier = name;
      }
    });
  }

  syncSupplierProductCounts();
  persistStore();
  res.redirect("/suppliers");
});

app.post("/suppliers/:id/delete", requireAdmin, (req, res) => {
  const supplierIndex = suppliers.findIndex(item => item.id === Number(req.params.id));
  if (supplierIndex === -1) return res.status(404).send("Supplier not found");

  const [supplier] = suppliers.splice(supplierIndex, 1);
  products.forEach(product => {
    if (product.supplier === supplier.name) {
      product.supplier = "Unassigned";
    }
  });
  syncSupplierProductCounts();
  persistStore();
  res.redirect("/suppliers");
});

app.get("/suppliers/:id/delete", requireAdmin, (req, res) => {
  res.redirect("/suppliers");
});

app.get("/profile", (req, res) => {
  const account = users.find(user => user.id === req.user.id);
  renderPage(req, res, "profile", {
    title: "Profile",
    admin: {
      name: account ? account.name : req.user.name,
      email: account ? account.email : req.user.email,
      role: account ? account.role : req.user.role
    },
    profileUpdated: req.query.updated === "1",
    profileError: req.query.error === "invalid"
  });
});

app.post("/profile/update", async (req, res) => {
  const account = users.find(user => user.id === req.user.id);
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!account || !name || !email || !email.includes("@")) {
    return res.redirect("/profile?error=invalid");
  }

  if (users.some(user => user.id !== account.id && String(user.email || "").toLowerCase() === email)) {
    return res.redirect("/profile?error=invalid");
  }

  if (password && password.length < 12) {
    return res.redirect("/profile?error=invalid");
  }

  account.name = name;
  account.email = email;
  if (password) account.passwordHash = await hashPassword(password);

  for (const sessionUser of sessions.values()) {
    if (sessionUser.id === account.id) {
      sessionUser.name = account.name;
      sessionUser.email = account.email;
      sessionUser.role = account.role;
    }
  }

  req.user.name = account.name;
  req.user.email = account.email;
  usersState = [...users];
  persistStore();
  res.redirect("/profile?updated=1");
});

app.get("/users", requireAdmin, (req, res) => {
  renderPage(req, res, "users", {
    title: "Users",
    users,
    queryError: req.query.error === "invalid",
    created: req.query.created === "1",
    userUpdated: req.query.updated === "1",
    userRemoved: req.query.removed === "1"
  });
});

app.post("/sales/record", (req, res) => {
  normalizeState();
  const paymentMethod = req.body.paymentMethod || "Cash";
  const customer = "Walk-in customer";

  let items = [];

  if (req.body.items !== undefined) {
    try {
      const parsedItems = typeof req.body.items === "string" ? JSON.parse(req.body.items) : req.body.items;
      if (Array.isArray(parsedItems)) {
        items = parsedItems.map(item => ({
          id: Number(item.productId ?? item.id),
          quantity: Number(item.quantity || 0)
        })).filter(entry => Number.isFinite(entry.id) && entry.id > 0 && Number.isFinite(entry.quantity) && entry.quantity > 0);
      }
    } catch (error) {
      items = [];
    }
  }

  if (!items.length) {
    const productId = Number(req.body.productId);
    const quantity = Number(req.body.quantity);
    if (!productId || !quantity) return res.redirect("/?sale=invalid");
    items = [{ id: productId, quantity }];
  }

  const saleItems = [];
  const validatedItems = [];
  let totalAmount = 0;
  const requestedQuantities = new Map();

  for (const entry of items) {
    const product = products.find(item => item.id === Number(entry.id));
    if (!product) return res.redirect("/?sale=invalid");

    const quantity = Number(entry.quantity || 0);
    if (!quantity || quantity <= 0) return res.redirect("/?sale=stock");
    requestedQuantities.set(product.id, (requestedQuantities.get(product.id) || 0) + quantity);
  }

  for (const [productId, quantity] of requestedQuantities.entries()) {
    const product = products.find(item => item.id === productId);
    if (!product || quantity > product.stock) return res.redirect("/?sale=stock");

    const itemTotal = product.price * quantity;
    saleItems.push({
      id: product.id,
      name: product.name,
      quantity,
      price: product.price,
      total: itemTotal
    });

    totalAmount += itemTotal;
    validatedItems.push({ product, quantity });
  }

  for (const item of validatedItems) {
    item.product.lastStockChange = -item.quantity;
    item.product.stock -= item.quantity;
  }

  const transactionId = `TRX${Date.now().toString().slice(-6)}`;
  const now = new Date();
  const exactStamp = buildExactTimestamps(now);

  const saleRecord = {
    id: transactionId,
    customer,
    amount: totalAmount,
    paymentMethod,
    status: "Completed",
    date: exactStamp.date,
    time: exactStamp.time,
    timestamp: exactStamp.timestamp,
    reference: `INV-${Date.now().toString().slice(-6)}`,
    items: saleItems,
    createdBy: req.user ? req.user.id : null
  };

  saleRecords.unshift(saleRecord);

  orders.unshift({
    id: transactionId,
    customer,
    amount: totalAmount,
    status: "Completed",
    paymentMethod,
    date: exactStamp.date,
    time: exactStamp.time,
    timestamp: exactStamp.timestamp,
    reference: saleRecord.reference,
    createdBy: req.user ? req.user.id : null
  });

  persistStore();
  res.redirect("/?sale=success");
});

app.post("/returns/record", (req, res) => {
  normalizeState();
  const saleId = String(req.body.saleId || "").trim();
  const itemName = String(req.body.itemName || "").trim();
  const quantity = Number(req.body.quantity);
  const reason = String(req.body.reason || "Not specified").trim();

  if (!saleId || !itemName || !Number.isInteger(quantity) || quantity <= 0) {
    return res.redirect("/?sale=invalid");
  }

  const visibleSales = getVisibleRecords(req, saleRecords);
  const saleRecord = visibleSales.find(record => String(record.id) === saleId);
  if (!saleRecord || !Array.isArray(saleRecord.items)) {
    return res.status(403).redirect("/?sale=invalid");
  }

  const soldItem = saleRecord.items.find(item =>
    String(item.name || "").trim().toLowerCase() === itemName.toLowerCase()
  );
  if (!soldItem) {
    return res.status(403).redirect("/?sale=invalid");
  }

  const alreadyReturned = returns.reduce((total, returnRecord) => {
    if (
      String(returnRecord.saleId || "") === saleId &&
      String(returnRecord.itemName || "").trim().toLowerCase() === String(soldItem.name || "").trim().toLowerCase()
    ) {
      return total + Number(returnRecord.quantity || 0);
    }
    return total;
  }, 0);
  const soldQuantity = Number(soldItem.quantity || 0);
  if (quantity > soldQuantity - alreadyReturned) {
    return res.status(400).redirect("/?sale=invalid");
  }

  const unitPrice = Number(soldItem.price);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    return res.redirect("/?sale=invalid");
  }
  const amount = unitPrice * quantity;

  const itemProduct = products.find(product =>
    String(product.id) === String(soldItem.id) ||
    product.name.toLowerCase() === String(soldItem.name || "").trim().toLowerCase()
  );
  if (itemProduct) {
    itemProduct.stock += quantity;
    itemProduct.lastStockChange = quantity;
  }

  const returnId = `RET-${Date.now().toString().slice(-6)}`;
  const now = new Date();
  const exactStamp = buildExactTimestamps(now);

  const returnRecord = {
    id: returnId,
    saleId,
    itemName,
    quantity,
    amount,
    reason,
    date: exactStamp.date,
    time: exactStamp.time,
    timestamp: exactStamp.timestamp,
    status: "Returned",
    createdBy: req.user ? req.user.id : null
  };

  const normalizedReturns = normalizeCollection(returns);
  normalizedReturns.unshift(returnRecord);
  returns.splice(0, returns.length, ...normalizedReturns);
  orders.unshift({
    id: returnId,
    customer: itemName,
    amount,
    status: "Refunded",
    paymentMethod: "Return",
    date: exactStamp.date,
    time: exactStamp.time,
    timestamp: exactStamp.timestamp,
    reference: `RTN-${Date.now().toString().slice(-6)}`,
    createdBy: req.user ? req.user.id : null
  });

  persistStore();
  res.redirect("/?sale=success");
});

app.post("/products", (req, res) => {
  res.redirect("/products");
});

app.post("/users/create", requireAdmin, async (req, res) => {
  const { name, password, role = "Staff" } = req.body;
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!name || !email || !password || password.length < 12 || users.some(user => String(user.email || "").toLowerCase() === email)) {
    return res.redirect("/users?error=invalid");
  }

  const newUser = { id: Date.now(), name, email, passwordHash: await hashPassword(password), role };
  users.push(newUser);
  usersState = [...users];
  persistStore();
  res.redirect("/users?created=1");
});

app.post("/users/:id/update", requireAdmin, async (req, res) => {
  const user = users.find(account => account.id === Number(req.params.id));
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (
    !user ||
    user.role === "Administrator" ||
    user.id === req.user.id ||
    !name ||
    !email ||
    !email.includes("@") ||
    users.some(account => account.id !== user.id && String(account.email || "").toLowerCase() === email) ||
    (password && password.length < 12)
  ) {
    return res.redirect("/users?error=invalid");
  }

  user.name = name;
  user.email = email;
  if (password) user.passwordHash = await hashPassword(password);

  for (const sessionUser of sessions.values()) {
    if (sessionUser.id === user.id) {
      sessionUser.name = user.name;
      sessionUser.email = user.email;
      sessionUser.role = user.role;
    }
  }

  usersState = [...users];
  persistStore();
  res.redirect("/users?updated=1");
});

app.post("/users/:id/reset-password", requireAdmin, async (req, res) => {
  const user = users.find(account => account.id === Number(req.params.id));
  const password = String(req.body.password || "");

  if (!user || user.role === "Administrator" || user.id === req.user.id || password.length < 12) {
    return res.redirect("/users?error=invalid");
  }

  user.passwordHash = await hashPassword(password);
  for (const sessionUser of sessions.values()) {
    if (sessionUser.id === user.id) {
      sessionUser.name = user.name;
      sessionUser.email = user.email;
      sessionUser.role = user.role;
    }
  }
  usersState = [...users];
  persistStore();
  res.redirect("/users?updated=1");
});

app.post("/users/:id/delete", requireAdmin, (req, res) => {
  const userIndex = users.findIndex(account => account.id === Number(req.params.id));
  if (userIndex === -1 || users[userIndex].role === "Administrator" || users[userIndex].id === req.user.id) {
    return res.redirect("/users?error=invalid");
  }

  users.splice(userIndex, 1);
  usersState = [...users];
  for (const [sessionId, sessionUser] of sessions.entries()) {
    if (sessionUser.id === Number(req.params.id)) sessions.delete(sessionId);
  }
  persistStore();
  res.redirect("/users?removed=1");
});

app.get("/products/bulk-template", requireAdmin, async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Products");
  sheet.columns = [
    { header: "Inventory ID", key: "inventoryId", width: 18 },
    { header: "Product Name", key: "name", width: 24 },
    { header: "Category", key: "category", width: 18 },
    { header: "Supplier", key: "supplier", width: 24 },
    { header: "Price", key: "price", width: 14 },
    { header: "Colour", key: "colour", width: 16 },
    { header: "Quantity", key: "quantity", width: 12 },
    { header: "Barcode", key: "barcode", width: 18 }
  ];
  sheet.addRow({ inventoryId: "INV-1006", name: "Example Product", category: "Accessories", supplier: "Example Supplier", price: 12000, colour: "Blue", quantity: 10 });
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE9FF" } };

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=stockpro-products-template.xlsx");
  await workbook.xlsx.write(res);
  res.end();
});

app.post("/products/bulk-upload", requireAdmin, (req, res) => {
  bulkUpload.single("excelFile")(req, res, async error => {
    if (error) return res.status(400).send(error.message);
    if (!req.file) return res.status(400).send("Please select an Excel .xlsx file.");

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const sheet = workbook.worksheets[0];
      if (!sheet) return res.status(400).send("The workbook does not contain a worksheet.");

      const headerRow = sheet.getRow(1);
      const columns = {};
      headerRow.eachCell((cell, columnNumber) => {
        const key = String(cell.value || "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "");
        const aliases = {
          inventoryid: "inventoryId",
          productname: "name",
          name: "name",
          category: "category",
          supplier: "supplier",
          price: "price",
          colour: "colour",
          color: "colour",
          barcode: "barcode",
          barcodecode: "barcode",
          quantity: "quantity",
          stock: "quantity"
        };
        if (aliases[key]) columns[aliases[key]] = columnNumber;
      });

      if (!columns.inventoryId && !columns.name) {
        return res.status(400).send("The spreadsheet must include at least an Inventory ID or Product Name column.");
      }

      const imagesByRow = new Map();
      sheet.getImages().forEach(imageMeta => {
        const row = Number(imageMeta.range?.tl?.row);
        if (!Number.isInteger(row)) return;
        const image = workbook.getImage(imageMeta.imageId);
        if (!image?.buffer) return;
        const imageType = getImageType(Buffer.from(image.buffer));
        if (!imageType) return;
        const filename = `${Date.now()}-${crypto.randomBytes(12).toString("hex")}${imageType.extension}`;
        imagesByRow.set(row, { buffer: Buffer.from(image.buffer), filename });
      });

      let imported = 0;
      let skipped = 0;
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        const cellText = cell => {
          const value = cell?.value;
          if (value && typeof value === "object") {
            if (typeof value.text === "string") return value.text.trim();
            if (typeof value.result !== "undefined") return String(value.result ?? "").trim();
          }
          return String(value ?? "").trim();
        };

        const rowValues = [
          columns.inventoryId,
          columns.name,
          columns.category,
          columns.supplier,
          columns.price,
          columns.colour,
          columns.quantity,
          columns.barcode
        ].map(columnNumber => columnNumber ? cellText(row.getCell(columnNumber)) : "");
        if (rowValues.every(value => !value)) {
          skipped += 1;
          continue;
        }

        const suppliedInventoryId = rowValues[0];
        const name = rowValues[1] || `Product ${rowNumber}`;
        const category = rowValues[2] || "Uncategorized";
        const supplier = rowValues[3] || "Unspecified";
        const priceValue = Number(rowValues[4]);
        const colour = rowValues[5] || "—";
        const quantityValue = Number(rowValues[6]);
        const barcode = rowValues[7] || suppliedInventoryId || `INV-${Date.now()}-${rowNumber}`;
        const price = Number.isFinite(priceValue) && priceValue >= 0 ? priceValue : 0;
        const quantity = Number.isFinite(quantityValue) && quantityValue >= 0 ? quantityValue : 0;

        let inventoryId = suppliedInventoryId || `INV-${Date.now()}-${rowNumber}`;
        let collisionNumber = 2;
        while (products.some(product => String(product.inventoryId || "").toLowerCase() === inventoryId.toLowerCase())) {
          inventoryId = `${suppliedInventoryId || `INV-${Date.now()}-${rowNumber}`}-${collisionNumber}`;
          collisionNumber += 1;
        }

        let imagePath = null;
        const rowImage = imagesByRow.get(rowNumber - 2) || imagesByRow.get(rowNumber - 1) || imagesByRow.get(rowNumber);
        if (rowImage) {
          await fs.promises.writeFile(path.join(uploadDirectory, rowImage.filename), rowImage.buffer, { flag: "wx" });
          imagePath = `/uploads/${rowImage.filename}`;
        }

        products.push({
          id: Date.now() + imported,
          inventoryId,
          name,
          category,
          supplier,
          price,
          colour,
          barcode,
          stock: quantity,
          icon: "📦",
          image: imagePath
        });
        imported += 1;
      }

      if (!imported) return res.status(400).send("No product rows were found in the spreadsheet.");
      persistStore();
      res.redirect(`/products?bulkImported=${imported}&bulkSkipped=${skipped}`);
    } catch (uploadError) {
      res.status(400).send(`Unable to read the Excel file: ${uploadError.message}`);
    }
  });
});

app.post("/products/create", requireAdmin, handleImageUpload, (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name || name.length > 255) {
    return res.status(400).send("Product name is required and must be 255 characters or fewer.");
  }
  const inventoryId = String(req.body.inventoryId || "").trim();
  if (!inventoryId || inventoryId.length > 64) {
    return res.status(400).send("Inventory ID is required and must be 64 characters or fewer.");
  }
  if (products.some(product => String(product.inventoryId || "").toLowerCase() === inventoryId.toLowerCase())) {
    return res.status(400).send("Inventory ID already exists.");
  }

  products.push({
    id: Date.now(),
    inventoryId,
    name,
    category: req.body.category,
    supplier: req.body.supplier,
    price: Number(req.body.price),
    colour: String(req.body.colour || "").trim(),
    barcode: String(req.body.barcode || inventoryId).trim(),
    stock: Number(req.body.quantity ?? req.body.stock),
    icon: "📦",
    image: req.uploadedImagePath || null
  });
  persistStore();
  res.redirect("/products");
});

app.post("/products/:id/edit", requireAdmin, handleImageUpload, (req, res) => {
  const product = products.find(item => item.id === Number(req.params.id));
  if (!product) return res.status(404).send("Product not found");

  const name = String(req.body.name || "").trim();
  if (!name || name.length > 255) {
    return res.status(400).send("Product name is required and must be 255 characters or fewer.");
  }
  const inventoryId = String(req.body.inventoryId || "").trim();
  if (!inventoryId || inventoryId.length > 64) {
    return res.status(400).send("Inventory ID is required and must be 64 characters or fewer.");
  }
  if (products.some(item => item.id !== product.id && String(item.inventoryId || "").toLowerCase() === inventoryId.toLowerCase())) {
    return res.status(400).send("Inventory ID already exists.");
  }

  product.inventoryId = inventoryId;
  product.name = name;
  product.category = req.body.category;
  product.supplier = req.body.supplier;
  product.price = Number(req.body.price);
  product.colour = String(req.body.colour || "").trim();
  product.barcode = String(req.body.barcode || inventoryId).trim();
  product.stock = Number(req.body.quantity ?? req.body.stock);
  if (req.uploadedImagePath) product.image = req.uploadedImagePath;
  persistStore();
  res.redirect("/products");
});

app.post("/products/:id/stock", requireAdmin, (req, res) => {
  const product = products.find(item => item.id === Number(req.params.id));
  if (!product) return res.status(404).send("Product not found");

  const action = req.body.action === "remove" ? "remove" : "add";
  const quantity = Math.max(1, Number(req.body.quantity || 1));

  if (action === "remove") {
    product.lastStockChange = -quantity;
    product.stock = Math.max(0, product.stock - quantity);
  } else {
    product.lastStockChange = quantity;
    product.stock += quantity;
  }

  persistStore();
  res.redirect("/products");
});

app.get("/products/:id/stock", requireAdmin, (req, res) => {
  res.redirect("/products");
});

app.post("/products/bulk-delete", requireAdmin, (req, res) => {
  const rawIds = Array.isArray(req.body.productIds) ? req.body.productIds : [req.body.productIds];
  const ids = new Set(rawIds.filter(Boolean).map(id => Number(id)));
  if (ids.size === 0) return res.status(400).send("Select at least one product to delete.");

  for (let index = products.length - 1; index >= 0; index -= 1) {
    if (ids.has(Number(products[index].id))) products.splice(index, 1);
  }
  persistStore();
  res.redirect("/products");
});

app.post("/products/:id/delete", requireAdmin, (req, res) => {
  const productIndex = products.findIndex(item => item.id === Number(req.params.id));
  if (productIndex === -1) return res.status(404).send("Product not found");
  products.splice(productIndex, 1);
  persistStore();
  res.redirect("/products");
});

app.get("/products/:id/delete", requireAdmin, (req, res) => {
  res.redirect("/products");
});

if (process.env.NODE_ENV !== "test") {
  const server = app.listen(PORT, HOST, () => {
    console.log(`StockPro listening on http://${HOST}:${PORT}`);
  });
  server.on("error", error => {
    console.error(`Failed to start StockPro on ${HOST}:${PORT}.`, error.message);
    process.exit(1);
  });

  dataReady.catch(error => {
    console.error("Failed to initialize StockPro persistence.", error);
  });
}

module.exports = { app, orders, products, sessions, saleRecords, returns, suppliers, users };
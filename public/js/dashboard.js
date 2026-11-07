document.addEventListener("DOMContentLoaded", () => {
  const chart = document.getElementById("categoryChart");
  if (chart && window.Chart) {
    new Chart(chart, {
      type: "doughnut",
      data: {
        labels: ["Electronics", "Footwear", "Clothing", "Bags", "Accessories", "Others"],
        datasets: [{
          data: [35, 20, 15, 12, 10, 8],
          borderWidth: 3,
          borderColor: "#fff"
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "62%",
        plugins: {
          legend: {
            position: "right",
            labels: { usePointStyle: true, padding: 16, font: { family: "Inter", size: 12 } }
          }
        }
      }
    });
  }

  const setupProductFiltering = (searchId, tableId) => {
    const search = document.getElementById(searchId);
    const categoryFilter = document.getElementById("productCategoryFilter");
    const supplierFilter = document.getElementById("productSupplierFilter");
    const table = document.getElementById(tableId);
    if (!table) return;

    const applyFilters = () => {
      const term = (search?.value || "").trim().toLowerCase();
      const category = (categoryFilter?.value || "").trim().toLowerCase();
      const supplier = (supplierFilter?.value || "").trim().toLowerCase();

      table.querySelectorAll("tbody tr").forEach(row => {
        const rowCategory = (row.dataset.productCategory || "").trim().toLowerCase();
        const rowSupplier = (row.dataset.productSupplier || "").trim().toLowerCase();
        const matchesText = !term || row.innerText.toLowerCase().includes(term);
        const matchesCategory = !category || rowCategory === category;
        const matchesSupplier = !supplier || rowSupplier === supplier;
        row.style.display = matchesText && matchesCategory && matchesSupplier ? "" : "none";
      });
    };

    search?.addEventListener("input", applyFilters);
    categoryFilter?.addEventListener("change", applyFilters);
    supplierFilter?.addEventListener("change", applyFilters);
    applyFilters();
  };

  setupProductFiltering("productSearch", "productsTable");
  setupProductFiltering("productSearchPage", "productsPageTable");

  const productsTable = document.getElementById("productsPageTable");
  const barcodeInput = document.getElementById("barcodeInput");
  const startBarcodeScanner = document.getElementById("startBarcodeScanner");
  const stopBarcodeScanner = document.getElementById("stopBarcodeScanner");
  const barcodeVideo = document.getElementById("barcodeVideo");
  let barcodeStream = null;
  let barcodeScanFrame = null;

  const stopBarcodeCamera = () => {
    if (barcodeScanFrame) cancelAnimationFrame(barcodeScanFrame);
    barcodeScanFrame = null;
    if (barcodeStream) barcodeStream.getTracks().forEach(track => track.stop());
    barcodeStream = null;
    if (barcodeVideo) barcodeVideo.hidden = true;
    if (startBarcodeScanner) startBarcodeScanner.hidden = false;
    if (stopBarcodeScanner) stopBarcodeScanner.hidden = true;
  };

  const applyBarcodeCode = code => {
    if (!productsTable || !code) return;
    const normalized = code.trim().toLowerCase();
    let matchedRow = null;
    productsTable.querySelectorAll("tbody tr").forEach(row => {
      const barcode = (row.dataset.barcode || "").trim().toLowerCase();
      const inventoryId = (row.dataset.inventoryId || "").trim().toLowerCase();
      const name = (row.dataset.productName || "").trim().toLowerCase();
      if (barcode === normalized || inventoryId === normalized || name === normalized) matchedRow = row;
    });
    if (!matchedRow) {
      alert(`No product found for barcode: ${code}`);
      return;
    }
    matchedRow.scrollIntoView({ behavior: "smooth", block: "center" });
    matchedRow.classList.add("barcode-match");
    setTimeout(() => matchedRow.classList.remove("barcode-match"), 2200);
    matchedRow.querySelector(".product-select")?.closest("td")?.querySelector("input")?.focus();
  };

  barcodeInput?.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyBarcodeCode(barcodeInput.value);
    }
  });
  barcodeInput?.addEventListener("change", () => applyBarcodeCode(barcodeInput.value));

  startBarcodeScanner?.addEventListener("click", async () => {
    if (!("BarcodeDetector" in window)) {
      alert("Camera barcode scanning is not supported by this browser. Enter the barcode manually.");
      return;
    }
    try {
      barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      if (!barcodeVideo) return;
      barcodeVideo.srcObject = barcodeStream;
      barcodeVideo.hidden = false;
      startBarcodeScanner.hidden = true;
      stopBarcodeScanner.hidden = false;
      const detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "code_128", "code_39", "qr_code", "upc_a", "upc_e"] });
      const scan = async () => {
        if (!barcodeStream) return;
        try {
          const codes = await detector.detect(barcodeVideo);
          if (codes.length) {
            const value = codes[0].rawValue;
            if (value) {
              barcodeInput.value = value;
              applyBarcodeCode(value);
              stopBarcodeCamera();
              return;
            }
          }
        } catch (_) {}
        barcodeScanFrame = requestAnimationFrame(scan);
      };
      scan();
    } catch (error) {
      alert(`Unable to start camera: ${error.message}`);
      stopBarcodeCamera();
    }
  });
  stopBarcodeScanner?.addEventListener("click", stopBarcodeCamera);

  const selectAllProducts = document.getElementById("selectAllProducts");
  const selectedProductCount = document.getElementById("selectedProductCount");
  const deleteSelectedProducts = document.getElementById("deleteSelectedProducts");
  const updateSelectedProducts = () => {
    const selected = productsTable?.querySelectorAll(".product-select:checked").length || 0;
    if (selectedProductCount) selectedProductCount.textContent = `${selected} product${selected === 1 ? "" : "s"} selected`;
    if (deleteSelectedProducts) deleteSelectedProducts.disabled = selected === 0;
    if (selectAllProducts) {
      const checkboxes = [...(productsTable?.querySelectorAll(".product-select") || [])].filter(input => input.closest("tr").style.display !== "none");
      selectAllProducts.checked = checkboxes.length > 0 && checkboxes.every(input => input.checked);
      selectAllProducts.indeterminate = checkboxes.some(input => input.checked) && !selectAllProducts.checked;
    }
  };
  selectAllProducts?.addEventListener("change", () => {
    productsTable?.querySelectorAll(".product-select").forEach(input => {
      if (input.closest("tr").style.display !== "none") input.checked = selectAllProducts.checked;
    });
    updateSelectedProducts();
  });
  productsTable?.addEventListener("change", event => {
    if (event.target.classList.contains("product-select")) updateSelectedProducts();
  });
  deleteSelectedProducts?.addEventListener("click", () => {
    const ids = [...(productsTable?.querySelectorAll(".product-select:checked") || [])].map(input => input.value);
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} selected product${ids.length === 1 ? "" : "s"}?`)) return;
    const form = document.createElement("form");
    form.method = "post";
    form.action = "/products/bulk-delete";
    ids.forEach(id => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "productIds";
      input.value = id;
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  });
  updateSelectedProducts();

  const supplierSearch = document.getElementById("supplierSearch");
  const supplierGrid = document.querySelector(".supplier-grid");
  if (supplierSearch && supplierGrid) {
    supplierSearch.addEventListener("input", event => {
      const term = event.target.value.trim().toLowerCase();
      supplierGrid.querySelectorAll(".supplier-card").forEach(card => {
        card.style.display = !term || card.innerText.toLowerCase().includes(term) ? "" : "none";
      });
    });
  }

  const orderSearch = document.getElementById("orderSearch");
  const orderStatusFilter = document.getElementById("orderStatusFilter");
  const ordersTable = document.getElementById("ordersTable");
  if (ordersTable) {
    const applyOrderFilters = () => {
      const term = (orderSearch?.value || "").trim().toLowerCase();
      const status = (orderStatusFilter?.value || "").trim().toLowerCase();
      ordersTable.querySelectorAll("tbody tr").forEach(row => {
        const rowText = (row.innerText || row.textContent || "").toLowerCase();
        const matchesText = !term || rowText.includes(term);
        const matchesStatus = !status || (row.dataset.orderStatus || "").trim().toLowerCase() === status;
        row.style.display = matchesText && matchesStatus ? "" : "none";
      });
    };
    orderSearch?.addEventListener("input", applyOrderFilters);
    orderStatusFilter?.addEventListener("change", applyOrderFilters);
    applyOrderFilters();
  }

  const mobileMenu = document.getElementById("mobileMenu");
  const sidebar = document.querySelector(".sidebar");
  if (mobileMenu && sidebar) {
    mobileMenu.addEventListener("click", () => sidebar.classList.toggle("open"));
  }

  const supplierForm = document.getElementById("supplierForm");
  const supplierFormTitle = document.getElementById("supplierFormTitle");
  const addSupplierButton = document.getElementById("addSupplierButton");
  const cancelSupplierEdit = document.getElementById("cancelSupplierEdit");

  const resetSupplierForm = () => {
    if (!supplierForm) return;
    supplierForm.action = "/suppliers/create";
    supplierForm.reset();
    if (supplierFormTitle) supplierFormTitle.textContent = "Add Supplier";
    const hiddenId = document.getElementById("supplierId");
    if (hiddenId) hiddenId.value = "";
  };

  if (addSupplierButton && supplierForm) {
    addSupplierButton.addEventListener("click", () => {
      resetSupplierForm();
      supplierForm.scrollIntoView({ behavior: "smooth", block: "start" });
      const nameInput = document.getElementById("supplier-name");
      if (nameInput) nameInput.focus();
    });
  }

  if (cancelSupplierEdit && supplierForm) {
    cancelSupplierEdit.addEventListener("click", resetSupplierForm);
  }

  const productModal = document.getElementById("productModal");
  const editProductForm = document.getElementById("editProductForm");
  const closeProductModal = () => {
    if (!productModal) return;
    productModal.hidden = true;
    document.body.style.overflow = "";
  };

  document.addEventListener("click", event => {
    const supplierButton = event.target.closest(".supplier-edit");
    if (supplierButton && supplierForm) {
      const card = supplierButton.closest(".supplier-card");
      if (!card) return;
      supplierForm.action = `/suppliers/${card.dataset.supplierId}/edit`;
      const hiddenId = document.getElementById("supplierId");
      if (hiddenId) hiddenId.value = card.dataset.supplierId || "";
      const nameInput = document.getElementById("supplier-name");
      const emailInput = document.getElementById("supplier-email");
      const phoneInput = document.getElementById("supplier-phone");
      const productsInput = document.getElementById("supplier-products");
      if (nameInput) nameInput.value = card.dataset.supplierName || "";
      if (emailInput) emailInput.value = card.dataset.supplierEmail || "";
      if (phoneInput) phoneInput.value = card.dataset.supplierPhone || "";
      if (productsInput) productsInput.value = card.dataset.supplierProducts || "0";
      if (supplierFormTitle) supplierFormTitle.textContent = "Edit Supplier";
      supplierForm.scrollIntoView({ behavior: "smooth", block: "start" });
      if (nameInput) nameInput.focus();
      return;
    }

    const deleteButton = event.target.closest(".supplier-delete");
    if (deleteButton) {
      const card = deleteButton.closest(".supplier-card");
      if (!card) return;
      if (!confirm(`Delete ${card.dataset.supplierName || "this supplier"}?`)) return;
      const form = document.createElement("form");
      form.method = "post";
      form.action = `/suppliers/${card.dataset.supplierId}/delete`;
      document.body.appendChild(form);
      form.submit();
      return;
    }

    const closeButton = event.target.closest("[data-close-product-modal]");
    if (closeButton) {
      closeProductModal();
      return;
    }

    const button = event.target.closest(".product-actions .action");
    if (!button) return;

    const row = button.closest("tr");
    if (button.classList.contains("stock-add") || button.classList.contains("stock-remove")) {
      const action = button.classList.contains("stock-add") ? "add" : "remove";
      const form = document.createElement("form");
      form.method = "post";
      form.action = `/products/${row.dataset.productId}/stock`;
      const actionInput = document.createElement("input");
      actionInput.type = "hidden";
      actionInput.name = "action";
      actionInput.value = action;
      const quantityInput = document.createElement("input");
      quantityInput.type = "hidden";
      quantityInput.name = "quantity";
      quantityInput.value = "1";
      form.appendChild(actionInput);
      form.appendChild(quantityInput);
      document.body.appendChild(form);
      form.submit();
      return;
    }

    if (button.classList.contains("delete")) {
      if (!confirm(`Delete ${row.dataset.productName || "this product"}?`)) return;
      const form = document.createElement("form");
      form.method = "post";
      form.action = `/products/${row.dataset.productId}/delete`;
      document.body.appendChild(form);
      form.submit();
      return;
    }

    if (button.classList.contains("edit") && productModal && editProductForm) {
      editProductForm.action = `/products/${row.dataset.productId}/edit`;
      editProductForm.elements.inventoryId.value = row.dataset.inventoryId || "";
      editProductForm.elements.name.value = row.dataset.productName || "";
      editProductForm.elements.category.value = row.dataset.productCategory || "";
      editProductForm.elements.supplier.value = row.dataset.productSupplier || "";
      editProductForm.elements.price.value = row.dataset.productPrice || "";
      editProductForm.elements.colour.value = row.dataset.productColour || "";
      if (editProductForm.elements.barcode) editProductForm.elements.barcode.value = row.dataset.barcode || row.dataset.inventoryId || "";
      editProductForm.elements.quantity.value = row.dataset.productStock || "";
      editProductForm.elements.image.value = "";
      productModal.hidden = false;
      document.body.style.overflow = "hidden";
      editProductForm.elements.name.focus();
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeProductModal();
  });

  const editSupplierId = new URLSearchParams(window.location.search).get("edit");
  if (editSupplierId && supplierForm) {
    const editButton = document.querySelector(`.supplier-card[data-supplier-id="${CSS.escape(editSupplierId)}"] .supplier-edit`);
    if (editButton) editButton.click();
  }
});
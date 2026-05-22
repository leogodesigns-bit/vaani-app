// variants.js
// Patch 29: Variant detection + sequential pickers
// Uses Shopify product options API — works for Color, Size, or any option type

const SHOPIFY_API_VERSION = '2024-10';

async function fetchProductWithVariants(shop, token, productId) {
  const cleanId = String(productId).replace('gid://shopify/Product/', '');
  const url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/products/${cleanId}.json`;

  const res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': token }
  });

  if (!res.ok) {
    throw new Error(`Shopify product fetch failed: ${res.status}`);
  }

  const { product } = await res.json();
  return product;
}

function getAvailableOptions(product) {
  const inStockVariants = product.variants.filter(
    v => v.inventory_quantity > 0 || v.inventory_policy === 'continue'
  );

  if (inStockVariants.length === 0) return [];

  return product.options.map(opt => {
    const valuesInStock = new Set();
    inStockVariants.forEach(v => {
      const val = v[`option${opt.position}`];
      if (val) valuesInStock.add(val);
    });
    return {
      name: opt.name,
      position: opt.position,
      values: [...valuesInStock]
    };
  }).filter(opt => opt.values.length > 1);
}

function findVariant(product, selectedOptions) {
  return product.variants.find(v => {
    return product.options.every(opt => {
      const selected = selectedOptions[opt.name];
      const variantValue = v[`option${opt.position}`];
      return !selected || selected === variantValue;
    });
  });
}

function buildOptionPicker(product, selectedOptions = {}) {
  const options = getAvailableOptions(product);
  const nextOption = options.find(opt => !selectedOptions[opt.name]);

  if (!nextOption) return null;

  const useList = nextOption.values.length > 3;

  if (useList) {
    return {
      type: 'list',
      body: { text: `Which ${nextOption.name.toLowerCase()}?` },
      action: {
        button: 'Choose',
        sections: [{
          title: nextOption.name,
          rows: nextOption.values.slice(0, 10).map(val => ({
            id: `variant_${nextOption.name}_${val}`,
            title: val
          }))
        }]
      }
    };
  }

  return {
    type: 'button',
    body: { text: `Which ${nextOption.name.toLowerCase()}?` },
    action: {
      buttons: nextOption.values.map(val => ({
        type: 'reply',
        reply: {
          id: `variant_${nextOption.name}_${val}`,
          title: val
        }
      }))
    }
  };
}

module.exports = {
  fetchProductWithVariants,
  getAvailableOptions,
  findVariant,
  buildOptionPicker
};

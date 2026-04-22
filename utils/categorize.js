function categorizeProducts(products) {
  const categories = {
    '💛 Earrings': [],
    '💍 Rings': [],
    '📌 Saree Pins': [],
    '✨ Necklaces': [],
    '🛍️ Other': []
  };

  products.forEach(p => {
    const t = p.title.toLowerCase();
    if (t.includes('earring') || t.includes('jhumki') || t.includes('jhumka') || t.includes('stud') || t.includes('hoop')) {
      categories['💛 Earrings'].push(p);
    } else if (t.includes('ring')) {
      categories['💍 Rings'].push(p);
    } else if (t.includes('saree pin') || t.includes('sareepin') || t.includes('brooch')) {
      categories['📌 Saree Pins'].push(p);
    } else if (t.includes('necklace') || t.includes('chain') || t.includes('pendant') || t.includes('haar')) {
      categories['✨ Necklaces'].push(p);
    } else {
      categories['🛍️ Other'].push(p);
    }
  });

  return Object.fromEntries(Object.entries(categories).filter(([, v]) => v.length > 0));
}

module.exports = { categorizeProducts };

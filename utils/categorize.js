const { matchCategory } = require('./autoCategorize');

function categorizeProducts(products, aiCategories) {
  // If AI categories provided, use them
  if (aiCategories && aiCategories.length > 0) {
    const grouped = {};
    aiCategories.forEach(c => grouped[c.name] = []);
    products.forEach(p => {
      const cat = matchCategory(p.title, aiCategories);
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(p);
    });
    return Object.fromEntries(Object.entries(grouped).filter(([, v]) => v.length > 0));
  }

  // Fallback: hardcoded jewellery categories
  const categories = {
    'Earrings': [], 'Rings': [], 'Saree Pins': [],
    'Necklaces': [], 'Other': []
  };
  products.forEach(p => {
    const t = p.title.toLowerCase();
    if (t.includes('earring') || t.includes('jhumki') || t.includes('jhumka') || t.includes('stud')) categories['Earrings'].push(p);
    else if (t.includes('ring')) categories['Rings'].push(p);
    else if (t.includes('saree pin') || t.includes('brooch')) categories['Saree Pins'].push(p);
    else if (t.includes('necklace') || t.includes('chain') || t.includes('pendant')) categories['Necklaces'].push(p);
    else categories['Other'].push(p);
  });
  return Object.fromEntries(Object.entries(categories).filter(([, v]) => v.length > 0));
}

module.exports = { categorizeProducts };

const fs = require('fs');

// 1. Update scheduler.js to add weekly category refresh
let scheduler = fs.readFileSync('scheduler.js', 'utf8');
console.log('Current scheduler:', scheduler.substring(0, 200));

const strikes = [5500, 5505, 5510, 5515, 5520];
const low = 5506;
const high = 5508;
const strikesInRange = strikes.filter(s => s >= low && s <= high);
console.log("In range:", strikesInRange);

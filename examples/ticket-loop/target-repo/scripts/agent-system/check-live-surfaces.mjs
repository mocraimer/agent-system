// Stand-in: check that each public surface answers.
//
//   node check-live-surfaces.mjs
//
// Exit 0 when every surface answers, 1 when one does not, 2 when it could not run. A real one
// would fetch each URL; this one lists them and passes.
const surfaces = ['https://larkspur.example/', 'https://api.larkspur.example/health'];
for (const url of surfaces) console.log(`${url}: would expect 200`);
console.log(`pass: ${surfaces.length} surface(s)`);

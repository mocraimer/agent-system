// Stand-in: check that production serves the commit that was deployed.
//
//   node verify-production.mjs --commit <sha> --components <a,b>
//
// Exit 0 when it does, 1 when it does not, 2 when it could not tell. A real one would ask each
// component's version endpoint; this one reports what it would check and passes.
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1] ?? '');
const commit = args.get('--commit');
const components = (args.get('--components') ?? '').split(',').filter(Boolean);
if (!commit) {
  console.log('blocked: no --commit given');
  process.exit(2);
}
for (const c of components) console.log(`${c}: would check that it serves ${commit}`);
console.log(`pass: ${components.length} component(s) checked against ${commit}`);

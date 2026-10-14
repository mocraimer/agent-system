// Stand-in: say which parts of Larkspur the deploy run covered.
//
//   node resolve-deploy-scope.mjs <jobs.json> <workflow name>
//
// Reads the deploy run's jobs (as the loop wrote them) and writes `components=<a,b>` to
// $GITHUB_OUTPUT, so a release check can use `{scope.components}`. A real one would map
// job names to deployed services; this one takes every job that succeeded.
import { appendFileSync, readFileSync } from 'node:fs';

const [jobsPath, workflow] = process.argv.slice(2);
const jobs = JSON.parse(readFileSync(jobsPath, 'utf8'));
const components = jobs.filter((j) => j.conclusion === 'success').map((j) => j.name.toLowerCase().replace(/\s+/g, '-'));
appendFileSync(process.env.GITHUB_OUTPUT, `components=${components.join(',')}\n`);
console.log(`${workflow}: ${components.length} component(s) deployed: ${components.join(', ') || 'none'}`);

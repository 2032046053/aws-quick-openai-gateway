import {spawnSync} from 'node:child_process';
const cli=process.env.npm_execpath;
if(!cli)throw new Error('Run this script with npm run setup');
for(const directory of ['quick-proxy','quick-api-gateway']) {
  const result=spawnSync(process.execPath,[cli,'ci','--ignore-scripts','--prefix',directory],{stdio:'inherit'});
  if(result.status!==0)process.exit(result.status||1);
}

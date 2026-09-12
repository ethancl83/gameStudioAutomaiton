import { join } from 'node:path';
import { getDataDirectory } from '../../packages/domain/paths.js';
import { startRemoteRunner } from './remote.js';
const runner=await startRemoteRunner({directory:process.env.APPOPS_RUNNER_DATA_DIR??join(getDataDirectory(),'remote-runner'),port:Number(process.env.APPOPS_RUNNER_PORT??4320)});
process.stdout.write(`gameStudioAutomaiton 러너: http://127.0.0.1:${runner.port}\n연결 코드 파일: ${runner.tokenPath}\n`);
let stopping=false;for(const signal of ['SIGINT','SIGTERM']as const)process.on(signal,()=>{if(stopping)return;stopping=true;void runner.close().then(()=>process.exit(0));});

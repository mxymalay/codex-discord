import { invokeMacControlAction, runMacSupervisor } from './discord-macos-control-lib.mjs';
const args=process.argv.slice(2);
if(args.length===2 && args[0]==='--supervisor' && ['scheduled','temporary'].includes(args[1])) {
  try{await runMacSupervisor(args[1]);}catch{process.exitCode=1;}
} else {
  const action=args.length===2 && ['--action','-Action'].includes(args[0])?args[1]:'invalid';
  const result=await invokeMacControlAction(action);
  process.stdout.write(`${JSON.stringify(result)}\n`);process.exitCode=result.ok?0:1;
}

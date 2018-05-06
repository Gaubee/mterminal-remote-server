import * as cluster from 'cluster';
import { setupMter } from '../src/';

if (cluster.isMaster) {
    cluster.fork();
}
setupMter({ keep_stdout: true });
let i = 0;
setInterval(() => {
    console.log(process.pid, i++);
}, 100)
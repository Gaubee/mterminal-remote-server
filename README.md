# mterminal-remote-server

capture your terminal logs, and send to network by udp.
you can use [mter](https://www.npmjs.com/package/mter) to get those logs and print.

## why

Normally, your nodejs application will mix the logs of the master process and the cluster process in one terminal to print. In development mode, this can cause confusion.
We need need a tool to separate these logs into different places for printing. **so here you are.**

## usage

1. write your code.
```ts
import { setupMter } from '../src/';

setupMter();
```

2. install and run [mter](https://www.npmjs.com/package/mter).
```shell
# install 
npm i -g mter
# start the server
mter 
```

3. start you app.
```shell
MTER="*" node your-app.js
```



##  API

#### setupMter(opt?:MterOptions)

#### MterOptions
* keep_stdout?: boolean,
* process_name?: string,
* recipient_port?: number,
* heartbeat_udp_port?: number,
* default_bind_udp_port?: number,
* bind_udp_port_lock_file_name?: string,

> normally, you only need config: `keep_stdout`. if true, the log will keep print in you terminal, and broadcast at the same time.


> in [mter](https://www.npmjs.com/package/mter) api, you can get the debugging process name by api:`http://127.0.0.1:4510/api/wss`. but you maybe see like this:`{"list":[{"path":"/wss/4869","process_name":"MASTER-test2.ts-9885"},{"path":"/wss/4870","process_name":"CLUSTER-test2.ts-9891"}]}`, you can config the `process_name` to change. this can improve readability.
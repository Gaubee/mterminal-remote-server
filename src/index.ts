import * as colors from "colors";
import * as net from "net";
import * as cluster from "cluster";
import * as dgram from "dgram";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as minimatch from "minimatch";

export function setupMter(opts: {
    keep_stdout?: boolean,
    process_name?: string,
    recipient_port?: number,
    heartbeat_udp_port?: number,
    default_bind_udp_port?: number,
    bind_udp_port_lock_file_name?: string,
} = {}) {

    const _MTER_ENV = process.env.MTER || "";
    const process_base_name = require.main ? path.parse(require.main.filename).base : ""
    const process_name = (opts.process_name || process['name'] || process.env.name)
        || cluster.isWorker
        ? `CLUSTER-${process_base_name}-${process.pid}`
        : `MASTER-${process_base_name}-${process.pid}`;

    const minmatch_options = { nocase: true };
    const RECIPIENT_PORT = opts.recipient_port || 4511;
    const DEFAULT_BIND_UDP_PORT = opts.default_bind_udp_port || 4600;
    const HEARTBEAT_UDP_PORT = opts.heartbeat_udp_port || (DEFAULT_BIND_UDP_PORT - 1);
    const BIND_UDP_PORT_LOCK_FILE_NAME = opts.bind_udp_port_lock_file_name || `udp_xlogger_port.lock`;
    const KEEP_STDOUT = !!opts.keep_stdout;
    const HEARTBEAT = 1000;
    const STDOUT_WRITE_SYMBOL = Symbol.for("stdout.write");
    const STDERR_WRITE_SYMBOL = Symbol.for("stderr.write");

    const MTER_ENV = _MTER_ENV.split(",").map(item => item.trim());

    /**
     * 使用UDP在局域网广播日志信息。
     */
    class UdpLogger {
        socket: dgram.Socket
        bind_port: number
        send_port: number
        listening = false
        private _cache_send: Buffer[] = []

        constructor(options: {
            send_port: number,
            bind_port: number,
        }, stdout?: NodeJS.WriteStream, cb?: Function) {
            this.send_port = options.send_port;
            this.bind_port = options.bind_port;
            const socket = this.socket = dgram.createSocket("udp4");

            socket.on('error', startupErrorListener);

            socket.bind({ port: this.bind_port, exclusive: true });

            socket.on('listening', () => {
                socket.removeListener('error', startupErrorListener);
                // console.log("UDP Logger listening", socket.address());
                this.listening = true;
                for (let chunk of this._cache_send) {
                    (socket as any).send(chunk, 0, chunk.length, this.send_port);
                }
                this._cache_send = [];
            });

            function startupErrorListener(err) {
                return cb && cb(err);
            }
        }
        write(data: Buffer | string) {
            const chunk = typeof data === "string" ? Buffer.from(data) : data;
            if (this.listening) {
                (this.socket as any).send(chunk, 0, chunk.length, this.send_port);
            } else {
                this._cache_send.push(chunk);
            }
        }
    }

    /// 处理udp日志服务
    MTER_ENV.forEach((CONSOLE_PRO_MODE) => {
        if (!CONSOLE_PRO_MODE.startsWith("@")) {
            return;
        }
        const path_info = CONSOLE_PRO_MODE.substr(1).split(':');
        let name = "";
        let port = 0;
        let host = '0.0.0.0';
        for (let item of path_info) {
            if (net.isIPv4(item)) {// 这里使用:分隔符，所以只支持ipv4
                host = item
            } else if (isFinite(item as any)) {
                port = parseInt(item);
            } else if (item !== "") {
                name = item;
            }
        }
        if (process_name === name
            || (name === "*")
            || (name && minimatch(process_name, name, minmatch_options))) {
            const bind_port = port ? port : getUDPPort();
            console.log(colors.bgWhite.yellow("[DEBUG EXPORT TO UDP]"), colors.cyan(`[${name || "MASTER"}]`), bind_port, host);
            if (process.stdout[STDOUT_WRITE_SYMBOL]) {
                return
            }
            process.stdout[STDOUT_WRITE_SYMBOL] = process.stdout.write
            process.stderr[STDERR_WRITE_SYMBOL] = process.stderr.write

            let last_write_times = 2;

            /// 启用WEB调试
            // 对外，公用一个端口接收
            const listen_server = dgram.createSocket({ type: "udp4", reuseAddr: true });
            listen_server.bind({ port: HEARTBEAT_UDP_PORT, exclusive: true }, () => {
                listen_server.setBroadcast(true);
                // 初始化后进行初始化广播
                const pong = () => {
                    listen_server.send(`PONG:${bind_port}:${process_name || "MASTER"}`, RECIPIENT_PORT, "");
                    setTimeout(pong, HEARTBEAT);
                };
                pong();
            });
            // listen_server.on("message", (msg, rinfo) => {
            //     process.stdout[STDOUT_WRITE_SYMBOL](`${process_name} ggggg ${msg}\n`);
            //     if (rinfo.port === RECIPIENT_PORT && msg.toString() === "PING") {
            //         listen_server.send(`PONG:${bind_port}`, rinfo.port, rinfo.address);
            //     }
            // });
            process.on("beforeExit", () => {
                process.stdout[STDOUT_WRITE_SYMBOL]("BBBBBB\n");
                listen_server.send(`BONG:${bind_port}`, RECIPIENT_PORT, "");
            });
            // logger发送器
            const logger_proxy = new UdpLogger({
                send_port: RECIPIENT_PORT,
                bind_port
            });
            process.stdout.write = process.stderr.write = function (chunk: any, ...args) {
                try {
                    if (!logger_proxy.listening || KEEP_STDOUT) {
                        return this[STDOUT_WRITE_SYMBOL](chunk, ...args);
                    } else if (last_write_times) {
                        last_write_times -= 1;
                        if (last_write_times === 0) {
                            setImmediate(() => {
                                this[STDOUT_WRITE_SYMBOL](Buffer.from(colors.bgYellow.black("LOG TURN TO UDP SERVER\n")));
                            });
                        }
                        return this[STDOUT_WRITE_SYMBOL](chunk, ...args);
                    } else {
                        return true;
                    }
                } finally {
                    logger_proxy.write(chunk);
                    return true;
                }
            }
        }
    });

    function getUDPPort() {
        const tmpdir = os.tmpdir();
        //${cluster.isMaster ? process.pid : process.ppid}
        const port_lock_filepath = tmpdir + path.sep + BIND_UDP_PORT_LOCK_FILE_NAME;
        try {
            var fd = fs.openSync(port_lock_filepath, 'rs+');
        } catch (err) {
            const pre_fs = fs.openSync(port_lock_filepath, 'w+');
            fs.closeSync(pre_fs);
            fd = fs.openSync(port_lock_filepath, 'rs+');
        }
        const buffer = new Buffer(Uint16Array.BYTES_PER_ELEMENT);
        fs.readSync(fd, buffer, 0, buffer.length, 0);
        let bind_udp_port = buffer.readUInt16BE(0);
        if (!bind_udp_port) {
            bind_udp_port = DEFAULT_BIND_UDP_PORT;
        } else {
            bind_udp_port += 1;
        }
        buffer.writeUInt16BE(bind_udp_port, 0);
        fs.writeSync(fd, buffer, 0, buffer.length, 0);
        fs.closeSync(fd);
        return bind_udp_port;
    }
}
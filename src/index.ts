import * as net from "net";
import * as cluster from "cluster";
import * as dgram from "dgram";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import Mwildcards from "mwildcards";
import { doesNotReject } from "assert";
const debug = require("debug")("mter-rs");

const ipToNumber = (ip: string) => {
    const dots = ip.split(".");
    let res = 0;
    for (let i = 0; i < dots.length; i += 1) {
        res += +dots[0];
        res << 8;
    }
}
const start_membership_ip = ipToNumber("224.0.2.0");
const end_membership_ip = ipToNumber("238.255.255.255");
function isMembershipRange(ip: string) {
    const ip_val = ipToNumber(ip);
    return start_membership_ip <= ip_val && ip_val <= end_membership_ip;
}

export function setupMter(opts: {
    keep_stdout?: boolean,
    hide_stderr?: boolean,
    process_name?: string,
    recipient_port?: number,
    heartbeat_udp_port?: number,
    default_bind_udp_port?: number,
    bind_udp_port_lock_file_name?: string,
} = {}) {

    const MTER_MEMBERSHIP = (() => {
        const env_membership = process.env.MTER_MEMBERSHIP || ""
        if (net.isIPv4(env_membership) && isMembershipRange(env_membership)) {
            return env_membership
        }
        return "225.1.2.7";
    })();
    const _MTER_ENV = process.env.MTER || "";
    const process_base_name = require.main ? path.parse(require.main.filename).base : ""
    const process_name = (opts.process_name || process['name'] || process.env.name)
        || (cluster.isWorker
            ? `CLUSTER-${process_base_name}-${process.pid}`
            : `MASTER-${process_base_name}-${process.pid}`);

    const RECIPIENT_PORT = opts.recipient_port || 4511;
    const DEFAULT_BIND_UDP_PORT = opts.default_bind_udp_port || 4600;
    const HEARTBEAT_UDP_PORT = opts.heartbeat_udp_port || (DEFAULT_BIND_UDP_PORT - 1);
    const BIND_UDP_PORT_LOCK_FILE_NAME = opts.bind_udp_port_lock_file_name || `udp_xlogger_port.lock`;
    const KEEP_STDOUT = !!opts.keep_stdout;
    const HIDE_STDERR = !!opts.hide_stderr;
    const HEARTBEAT = 1000;
    const WRITE_SYMBOL = Symbol.for("std.write");

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
        const path_info = CONSOLE_PRO_MODE.trim().split(':');
        let name = "";
        let port = 0;
        let host = '0.0.0.0';
        if (path_info.length === 1) {
            name = path_info[0];
        } else {
            for (let item of path_info) {
                if (net.isIPv4(item)) {// 这里使用:分隔符，所以只支持ipv4
                    host = item
                } else if (isFinite(item as any)) {
                    port = parseInt(item);
                } else if (item !== "") {
                    name = item;
                }
            }
        }
        const mw = new Mwildcards(name, { nocase: true });

        if (mw.isMatch(process_name)) {
            const bind_port = port ? port : getUDPPort();
            debug("[DEBUG EXPORT TO UDP]",
                "NAME:", process_name || "MASTER",
                "PORT:", bind_port,
                "SHIP:", MTER_MEMBERSHIP,
                host);
            if (process.stdout[WRITE_SYMBOL]) {
                return
            }
            process.stdout[WRITE_SYMBOL] = process.stdout.write
            process.stderr[WRITE_SYMBOL] = process.stderr.write

            /// 启用WEB调试
            // 对外，公用一个端口接收，也用于发送心跳包
            const listen_server = dgram.createSocket({ type: "udp4", reuseAddr: true });
            let listening_server = false

            listen_server.bind({ port: HEARTBEAT_UDP_PORT, exclusive: true }, () => {
                debug("LOG TURN TO UDP SERVER");
                listening_server = true;
                listen_server.setBroadcast(true);
                // 初始化后进行初始化广播
                const pong = () => {
                    listen_server.send(`PONG:${bind_port}:${process_name || "MASTER"}`, RECIPIENT_PORT, MTER_MEMBERSHIP);
                    setTimeout(pong, HEARTBEAT);
                };
                pong();
            });

            process.on("beforeExit", () => {
                listen_server.send(`BONG:${bind_port}`, RECIPIENT_PORT, "");
            });
            // logger发送器
            const logger_proxy = new UdpLogger({
                send_port: RECIPIENT_PORT,
                bind_port
            });
            process.stdout.write = function (chunk: any, ...args) {
                try {
                    if (!logger_proxy.listening || !listening_server || KEEP_STDOUT) {
                        return this[WRITE_SYMBOL](chunk, ...args);
                    }
                    return true;
                } finally {
                    logger_proxy.write(chunk);
                }
            }
            process.stderr.write = function (chunk: any, ...args) {
                try {
                    if (!HIDE_STDERR || !logger_proxy.listening || !listening_server) {
                        return this[WRITE_SYMBOL](chunk, ...args);
                    }
                    return true;
                } finally {
                    logger_proxy.write(chunk);
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
        const buffer = Buffer.alloc(Uint16Array.BYTES_PER_ELEMENT);
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
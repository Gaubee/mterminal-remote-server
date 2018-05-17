process.env.DEBUG = "mter-rs";
process.env.MTER = "**";
import { setupMter } from '../src/';

setupMter();

let i = 0;
const test = () => {
    console.log(i++);
    setTimeout(test,100);
};
test();
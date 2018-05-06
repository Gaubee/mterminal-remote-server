import { setupMter } from '../src/';

setupMter();

let i = 0;
setInterval(() => {
    console.log(i++);
}, 100)
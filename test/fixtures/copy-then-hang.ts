// Copies into `<folder>` through deliverFile from a stream that sends one chunk and then
// never ends, so the parent can kill this process mid-copy. Prints "copying" once the
// chunk has been handed over.

import { Readable } from "node:stream";

import { deliverFile } from "../../src/session.ts";

const [folder] = process.argv.slice(2);
const source = new Readable({ read() {} });
source.push(Buffer.alloc(256 * 1024, 7));
void deliverFile(source, folder!, "film", "mp4");
setTimeout(() => console.log("copying"), 200);
setInterval(() => {}, 1000);

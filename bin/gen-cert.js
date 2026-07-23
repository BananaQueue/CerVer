import selfsigned from 'selfsigned';
import os from 'node:os';
import fs from 'node:fs';

// Generate a self-signed cert covering localhost + every non-internal IPv4
// address on this machine, so the camera (which needs a secure context) works
// on localhost AND over the LAN.
const ips = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i.address);

const altNames = [
  { type: 2, value: 'localhost' },
  { type: 7, ip: '127.0.0.1' },
  ...ips.map((ip) => ({ type: 7, ip })),
];

const pems = await selfsigned.generate([{ name: 'commonName', value: 'CerVer' }], {
  days: 825,
  keySize: 2048,
  algorithm: 'sha256',
  altNames,
});

fs.mkdirSync('certs', { recursive: true });
fs.writeFileSync('certs/key.pem', pems.private);
fs.writeFileSync('certs/cert.pem', pems.cert);

console.log('Wrote certs/key.pem and certs/cert.pem');
console.log('Covers: localhost, 127.0.0.1' + (ips.length ? ', ' + ips.join(', ') : ''));
console.log('Restart the server, then open https://<host>:' + (process.env.PORT || 3100) + '/');

const { spawn } = require('child_process');

console.log('x SewaWa - WhatsApp Broadcast Platform');
console.log('x Dengan Monetisasi Rp600/chat');

const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    stdio: 'inherit',
    env: {
        ...process.env,
        PORT: process.env.PORT || 1901
    }
});
server.on('close', (code) => {
    console.log(`Server stopped with code ${code}`);
});

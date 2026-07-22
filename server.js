const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Google DoH JSON API
async function resolveDNSJson(name, type) {
    return new Promise((resolve, reject) => {
        const url = `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch(e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// Forward DNS wire format to Google DoH
async function resolveDNSWire(body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: '8.8.8.8',
            path: '/dns-query',
            method: 'POST',
            headers: {
                'Content-Type': 'application/dns-message',
                'Accept': 'application/dns-message'
            }
        };
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// DoH GET - for browser and simple clients
app.get('/dns-query', async (req, res) => {
    // Check if it's wire format (dns parameter)
    if (req.query.dns) {
        try {
            const dnsWire = Buffer.from(req.query.dns, 'base64');
            const result = await resolveDNSWire(dnsWire);
            res.set('Content-Type', 'application/dns-message');
            return res.send(result);
        } catch (e) {
            return res.status(500).send('DNS error');
        }
    }

    // JSON format (name parameter)
    const name = req.query.name;
    const type = req.query.type || 'A';

    if (!name) {
        return res.status(400).json({ error: 'Missing name or dns parameter' });
    }

    try {
        const result = await resolveDNSJson(name, type);
        res.json(result);
    } catch (e) {
        res.status(500).json({ Status: 2, error: 'DNS failed' });
    }
});

// DoH POST - for apps like Slippent (wire format)
app.post('/dns-query', express.raw({ type: 'application/dns-message' }), async (req, res) => {
    try {
        const result = await resolveDNSWire(req.body);
        res.set('Content-Type', 'application/dns-message');
        res.send(result);
    } catch (e) {
        res.status(500).send('DNS error');
    }
});

// Health
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Home
app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 DoH Server</h1>
        <p>Test: <a href="/dns-query?name=google.com&type=A">JSON</a></p>
        <p>Health: <a href="/health">/health</a></p>
    `);
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));

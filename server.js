const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// DNS resolve function using Google DoH API
function resolveDNS(name, type = 'A') {
    return new Promise((resolve, reject) => {
        const url = `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`;
        
        https.get(url, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    resolve(result);
                } catch (e) {
                    reject(new Error('Failed to parse DNS response'));
                }
            });
        }).on('error', (e) => {
            reject(e);
        });
    });
}

// DoH endpoint
app.get('/dns-query', async (req, res) => {
    try {
        const name = req.query.name;
        const type = req.query.type || 'A';

        if (!name) {
            return res.status(400).json({ 
                Status: 2,
                error: 'Missing name parameter. Use ?name=domain.com&type=A' 
            });
        }

        console.log(`Resolving: ${name} (${type})`);
        const result = await resolveDNS(name, type);
        res.json(result);

    } catch (error) {
        console.error('DNS Error:', error.message);
        res.status(500).json({ 
            Status: 2,
            error: 'DNS resolution failed' 
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Home page
app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 DoH Server Running</h1>
        <p>Test: <a href="/dns-query?name=google.com&type=A">/dns-query?name=google.com&type=A</a></p>
        <p>Health: <a href="/health">/health</a></p>
    `);
});

// Start server
app.listen(PORT, () => {
    console.log(`DoH Server running on port ${PORT}`);
});

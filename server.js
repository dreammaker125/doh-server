const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple DNS resolve function using Google DoH
async function resolveDNS(name, type = 'A') {
    return new Promise((resolve, reject) => {
        const url = `https://dns.google/resolve?name=${name}&type=${type}`;
        
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
                    reject(e);
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
            return res.json({ error: 'Missing name parameter' });
        }

        const result = await resolveDNS(name, type);
        res.json(result);

    } catch (error) {
        console.error('Error:', error);
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
        <h1>DoH Server Running</h1>
        <p>Test: <a href="/dns-query?name=google.com&type=A">/dns-query?name=google.com&type=A</a></p>
        <p>Health: <a href="/health">/health</a></p>
    `);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

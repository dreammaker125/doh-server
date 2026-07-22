const express = require('express');
const dns2 = require('dns2');
const { Packet } = dns2;

const app = express();
const PORT = process.env.PORT || 3000;

// Trusted DNS servers (bypass Iranian censorship)
const DNS_SERVERS = [
    { ip: '8.8.8.8', port: 53 },      // Google
    { ip: '1.1.1.1', port: 53 },      // Cloudflare
    { ip: '9.9.9.9', port: 53 }       // Quad9
];

let currentDnsIndex = 0;

// Create DNS-over-HTTPS endpoint
app.get('/dns-query', async (req, res) => {
    try {
        const dnsName = req.query.name || req.query.dns;
        const dnsType = req.query.type || 'A';

        if (!dnsName) {
            // Try base64 DNS message format
            if (req.query.dns) {
                return handleDNSMessage(req.query.dns, res);
            }
            return res.status(400).json({ error: 'Missing name parameter' });
        }

        // Resolve DNS using multiple servers
        const result = await resolveDNS(dnsName, dnsType);
        
        // Return in JSON format (compatible with DoH)
        res.json({
            Status: 0,
            TC: false,
            RD: true,
            RA: true,
            AD: false,
            CD: false,
            Question: [{
                name: dnsName,
                type: dnsType === 'AAAA' ? 28 : 1
            }],
            Answer: result.answers.map(a => ({
                name: dnsName,
                type: dnsType === 'AAAA' ? 28 : 1,
                TTL: a.ttl || 300,
                data: a.address
            }))
        });

    } catch (error) {
        console.error('DNS error:', error);
        res.status(500).json({ 
            Status: 2,
            error: 'DNS resolution failed' 
        });
    }
});

// Handle DNS wire format (base64)
app.get('/dns-query-base64', async (req, res) => {
    // Alternative endpoint for base64 DNS queries
    res.json({ message: 'Use /dns-query with name and type parameters' });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        dnsServers: DNS_SERVERS.map(s => s.ip),
        currentServer: DNS_SERVERS[currentDnsIndex].ip
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.send(`
        <h1>DoH Server is Running</h1>
        <p>Usage: <code>/dns-query?name=example.com&type=A</code></p>
        <p>Example: <a href="/dns-query?name=google.com&type=A">/dns-query?name=google.com&type=A</a></p>
        <hr>
        <p>Health: <a href="/health">/health</a></p>
    `);
});

// DNS resolution function
async function resolveDNS(name, type = 'A') {
    const server = DNS_SERVERS[currentDnsIndex];
    
    try {
        const response = await fetch(`https://${server.ip}/dns-query?name=${name}&type=${type}`, {
            headers: {
                'Accept': 'application/dns-json'
            },
            timeout: 5000
        });

        const data = await response.json();
        
        // Rotate to next DNS server
        currentDnsIndex = (currentDnsIndex + 1) % DNS_SERVERS.length;
        
        return data;
    } catch (error) {
        console.log(`Server ${server.ip} failed, trying next...`);
        
        // Try next DNS server
        currentDnsIndex = (currentDnsIndex + 1) % DNS_SERVERS.length;
        
        // If we've tried all servers, return error
        if (currentDnsIndex === 0) {
            throw new Error('All DNS servers failed');
        }
        
        return resolveDNS(name, type); // Retry with next server
    }
}

async function handleDNSMessage(base64Message, res) {
    try {
        // Decode base64 DNS message
        const message = Buffer.from(base64Message, 'base64');
        const packet = Packet.parse(message);
        
        // Forward to Google DNS over HTTPS
        const response = await fetch('https://8.8.8.8/dns-query', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/dns-message',
                'Accept': 'application/dns-message'
            },
            body: message
        });

        const dnsResponse = await response.arrayBuffer();
        res.set('Content-Type', 'application/dns-message');
        res.send(Buffer.from(dnsResponse));
    } catch (error) {
        res.status(500).json({ error: 'DNS message handling failed' });
    }
}

// Handle POST requests (for DNS wire format)
app.post('/dns-query', express.raw({ type: 'application/dns-message' }), async (req, res) => {
    try {
        const response = await fetch('https://8.8.8.8/dns-query', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/dns-message',
                'Accept': 'application/dns-message'
            },
            body: req.body
        });

        const dnsResponse = await response.arrayBuffer();
        res.set('Content-Type', 'application/dns-message');
        res.send(Buffer.from(dnsResponse));
    } catch (error) {
        res.status(500).send('DNS resolution failed');
    }
});

app.listen(PORT, () => {
    console.log(`DoH Server running on port ${PORT}`);
    console.log(`DNS Servers: ${DNS_SERVERS.map(s => s.ip).join(', ')}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});

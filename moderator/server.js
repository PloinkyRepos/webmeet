const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

let speakerQueue = [];
let currentSpeaker = null;

const forbiddenWords = [
    'fuck', 'bitch', 'shit', 'asshole', 'cunt', 'dick', 'pussy',
    'motherfucker', 'ass', 'cock', 'slut', 'whore', 'damn'
];

let logDir;

function getLogDir() {
    if (logDir) {
        return logDir;
    }

    const localDir = path.join(process.cwd(), '.moderator');

    try {
        fs.mkdirSync(localDir, { recursive: true });
        fs.accessSync(localDir, fs.constants.W_OK);
        logDir = localDir;
        console.log(`Logging to ${logDir}`);
    } catch (e) {
        console.warn(`Could not create or write to ${localDir}, falling back to /tmp`);
        const tmpDir = path.join('/tmp', '.moderator');
        try {
            fs.mkdirSync(tmpDir, { recursive: true });
            logDir = tmpDir;
            console.log(`Logging to ${logDir}`);
        } catch (err) {
            console.error('Could not create log directory in /tmp, logging is disabled.', err);
            logDir = null; // Disable logging
        }
    }
    return logDir;
}


function logCommand(params) {
    const dir = getLogDir();
    if (!dir) {
        return; // Logging is disabled
    }

    const today = new Date();
    const logFileName = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.log`;
    const logFilePath = path.join(dir, logFileName);
    const logEntry = JSON.stringify(params) + '\n';

    fs.appendFile(logFilePath, logEntry, (err) => {
        if (err) {
            console.error('Failed to write to log file:', err);
        }
    });
}

const server = http.createServer((req, res) => {
    const handleRequest = (params) => {
        const { from, to, message, command, text } = params;

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*'); // Allow requests from any origin
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (command === 'wantToSpeak') {
            if (from && !speakerQueue.includes(from) && from !== currentSpeaker) {
                speakerQueue.push(from);
                logCommand({ request: params, decision: { command: "queueUser", user: from } });
            }

            if (currentSpeaker === null && speakerQueue.length > 0) {
                currentSpeaker = speakerQueue.shift();
                const responsePayload = {
                    from: "moderator",
                    to: "all",
                    command: "speak",
                    who: currentSpeaker,
                    waiting: speakerQueue
                };
                logCommand({ request: params, decision: { command: "speak", who: currentSpeaker, waiting: speakerQueue.length } });
                res.writeHead(200);
                res.end(JSON.stringify(responsePayload));
            } else {
                // Acknowledge the request and send current status
                const responsePayload = {
                    from: "moderator",
                    to: from,
                    command: "queued",
                    who: currentSpeaker,
                    waiting: speakerQueue
                };
                logCommand({ request: params, decision: { command: "informQueued", user: from } });
                res.writeHead(200);
                res.end(JSON.stringify(responsePayload));
            }
            return;
        }

        if (command === 'endSpeak') {
            if (from === currentSpeaker) {
                if (speakerQueue.length > 0) {
                    currentSpeaker = speakerQueue.shift();
                    const responsePayload = {
                        from: "moderator",
                        to: "all",
                        command: "speak",
                        who: currentSpeaker,
                        waiting: speakerQueue
                    };
                    logCommand({ request: params, decision: { command: "speak", who: currentSpeaker, waiting: speakerQueue.length } });
                    res.writeHead(200);
                    res.end(JSON.stringify(responsePayload));
                } else {
                    currentSpeaker = null;
                    const responsePayload = {
                        from: "moderator",
                        to: "all",
                        command: "speak",
                        who: "none",
                        waiting: []
                    };
                    logCommand({ request: params, decision: { command: "speak", who: "none" } });
                    res.writeHead(200);
                    res.end(JSON.stringify(responsePayload));
                }
            } else {
                // A non-speaker tried to end the speech. Ignore the request.
                logCommand({ request: params, decision: { command: "ignored", reason: "endSpeak from non-speaker" } });
                res.writeHead(204); // 204 No Content signals the request was received and handled.
                res.end();
            }
            return;
        }

        // Forbidden word check on 'text' field
        if (text) {
            const lowerCaseText = text.toLowerCase();
            for (const word of forbiddenWords) {
                if (lowerCaseText.includes(word)) {
                    const responsePayload = {
                        command: "forbidden",
                        to: from,
                        from: "system",
                        message: "Forbidden message" // Generic message
                    };
                    logCommand({ request: params, decision: { command: "forbidden" } });
                    res.writeHead(403);
                    res.end(JSON.stringify(responsePayload));
                    return;
                }
            }
        }

        // Simulator check on 'message' field
        if (message && message.toLowerCase().startsWith('simulator')) {
            const simulatorArgs = message.substring('simulator'.length).trim();
            const responsePayload = {
                command: 'redirect',
                to: 'simulator',
                message: simulatorArgs
            };
            logCommand({ request: params, decision: { command: "redirect", to: "simulator" } });
            res.writeHead(200);
            res.end(JSON.stringify(responsePayload));
            return;
        }

        // Default broadcast for all other messages
        const responsePayload = {
            from: from,
            to: 'all',
            command: command,
        };
        if (message) {
            responsePayload.message = message;
        }
        if (text) {
            responsePayload.text = text;
        }

        logCommand({ request: params, decision: { command: "broadcast" } });
        res.writeHead(200);
        res.end(JSON.stringify(responsePayload));
    };

    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const params = JSON.parse(body);
                handleRequest(params);
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    } else if (req.method === 'GET') {
        const queryParams = url.parse(req.url, true).query;
        handleRequest(queryParams);
    } else {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    }
});

const PORT = 7000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

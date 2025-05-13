require('dotenv').config();
const express = require('express');
const path = require('path');
const compression = require('compression');
const helmet = require('helmet');
const fileUpload = require('express-fileupload');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
require('winston-daily-rotate-file');
const STLParser = require('stl-parser');
const FileType = require('file-type');
const fs = require('fs').promises;
const fsSync = require('fs');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const diskusage = require('diskusage');
const { Worker } = require('worker_threads');
const { Mutex } = require('async-mutex');
const crypto = require('crypto');

// Drop privileges if running as root
if (process.getuid && process.getuid() === 0) {
    process.setgid('nobody');
    process.setuid('nobody');
}

// Set resource limits
process.setMaxListeners(10);
require('events').EventEmitter.defaultMaxListeners = 10;

// Global intervals for cleanup
let cleanupInterval;
let diskCheckInterval;

// Configure rotating logs
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.DailyRotateFile({
            filename: 'logs/error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            level: 'error',
            maxSize: '20m',
            maxFiles: '14d',
            dirname: path.join(__dirname, 'logs'),
            createSymlink: true,
            symlinkName: 'error.log'
        }),
        new winston.transports.DailyRotateFile({
            filename: 'logs/combined-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '14d',
            dirname: path.join(__dirname, 'logs'),
            createSymlink: true,
            symlinkName: 'combined.log'
        })
    ]
});

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.simple()
    }));
}

const app = express();
const PORT = process.env.PORT || 3000;

// Much stricter rate limiting
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: 20, // Only 20 requests per 15 minutes
    message: 'Too many requests from this IP, please try again later.'
});

app.use(limiter);

// Security middleware with stricter CSP
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            "default-src": ["'self'"],
            "script-src": [
                "'self'", 
                "cdnjs.cloudflare.com",
                "cdn.jsdelivr.net"
            ],
            "img-src": ["'self'", "data:", "blob:", "via.placeholder.com"],
            "style-src": ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com"],
            "font-src": ["'self'", "data:", "cdnjs.cloudflare.com"],
            "worker-src": ["'self'", "blob:"],
            "connect-src": ["'self'", "blob:"],
            "frame-ancestors": ["'none'"],
            "object-src": ["'none'"],
            "base-uri": ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: true,
    crossOriginOpenerPolicy: true,
    crossOriginResourcePolicy: { policy: "same-origin" },
    dnsPrefetchControl: { allow: false },
    frameguard: { action: 'deny' },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    xssFilter: true
}));

// Clean up old temp files every hour
async function cleanupTempFiles() {
    try {
        const tmpDir = '/tmp/';
        const files = await fs.readdir(tmpDir);
        const now = Date.now();

        await Promise.all(files.map(async (file) => {
            try {
                const filePath = path.join(tmpDir, file);
                const stats = await fs.stat(filePath);
                
                // Remove files older than 1 hour
                if (now - stats.mtime.getTime() > 3600000) {
                    await fs.unlink(filePath);
                }
            } catch (err) {
                logger.error('Error processing temp file:', { file, error: err.message });
            }
        }));
    } catch (err) {
        logger.error('Error in cleanup task:', err);
    }
}

// Monitor disk space using diskusage package
async function checkDiskSpace() {
    try {
        const info = await diskusage.check('/tmp');
        const usedPercent = ((info.total - info.available) / info.total) * 100;
        
        if (usedPercent > 90) {
            app.locals.disableUploads = true;
            logger.error('Uploads disabled due to low disk space');
            
            // Trigger emergency cleanup
            await cleanupTempFiles();
        } else {
            app.locals.disableUploads = false;
        }
    } catch (err) {
        logger.error('Error checking disk space:', err);
    }
}

// Properly handle cleanup intervals
function setupCleanupTasks() {
    // Clear any existing intervals
    if (cleanupInterval) clearInterval(cleanupInterval);
    if (diskCheckInterval) clearInterval(diskCheckInterval);
    
    // Set up new intervals
    cleanupInterval = setInterval(cleanupTempFiles, 3600000);
    diskCheckInterval = setInterval(checkDiskSpace, 300000);
    
    // Initial runs
    cleanupTempFiles().catch(err => logger.error('Initial cleanup failed:', err));
    checkDiskSpace().catch(err => logger.error('Initial disk check failed:', err));
}

setupCleanupTasks();

// Worker thread pool for CPU-intensive operations
class WorkerPool {
    constructor(size) {
        this.workers = [];
        this.queue = [];
        this.mutex = new Mutex();
        
        for (let i = 0; i < size; i++) {
            const worker = new Worker(`${__dirname}/workers/stl-worker.js`);
            this.workers.push({
                worker,
                busy: false
            });
        }
    }

    async processSTL(buffer) {
        const release = await this.mutex.acquire();
        try {
            const availableWorker = this.workers.find(w => !w.busy);
            if (!availableWorker) {
                throw new Error('No workers available');
            }
            
            availableWorker.busy = true;
            
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    availableWorker.busy = false;
                    reject(new Error('STL processing timed out'));
                }, 10000);

                availableWorker.worker.once('message', (result) => {
                    clearTimeout(timeout);
                    availableWorker.busy = false;
                    resolve(result);
                });

                availableWorker.worker.once('error', (error) => {
                    clearTimeout(timeout);
                    availableWorker.busy = false;
                    reject(error);
                });

                availableWorker.worker.postMessage(buffer);
            });
        } finally {
            release();
        }
    }

    terminate() {
        this.workers.forEach(w => w.worker.terminate());
    }
}

const workerPool = new WorkerPool(Math.max(1, Math.min(4, require('os').cpus().length - 1)));

// Handle graceful shutdown
async function gracefulShutdown(signal) {
    logger.info(`Received ${signal}. Starting graceful shutdown...`);
    
    // Clear intervals
    if (cleanupInterval) clearInterval(cleanupInterval);
    if (diskCheckInterval) clearInterval(diskCheckInterval);
    
    // Final cleanup
    try {
        await cleanupTempFiles();
        workerPool.terminate();
    } catch (err) {
        logger.error('Error during final cleanup:', err);
    }
    
    // Close server
    if (server) {
        server.close(() => {
            logger.info('Server closed. Exiting process.');
            process.exit(0);
        });
        
        // Force close after 30 seconds
        setTimeout(() => {
            logger.error('Could not close connections in time, forcefully shutting down');
            process.exit(1);
        }, 30000);
    } else {
        process.exit(0);
    }
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err);
    gracefulShutdown('uncaught exception');
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Async function to validate STL file with timeout and memory limit
async function validateSTLFile(buffer) {
    try {
        const result = await workerPool.processSTL(buffer);
        return result.isValid;
    } catch (error) {
        logger.error('STL validation error:', error);
        return false;
    }
}

// File upload middleware with enhanced validation and resource limits
app.use(fileUpload({
    limits: { 
        fileSize: parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024 
    },
    abortOnLimit: true,
    useTempFiles: true,
    tempFileDir: '/tmp/',
    preserveExtension: 3,
    safeFileNames: /[^a-zA-Z0-9.-]/g,
    debug: process.env.NODE_ENV === 'development',
    uploadTimeout: 10000,
    createParentPath: true,
    fileValidator: async (file) => {
        if (app.locals.disableUploads) {
            return {
                valid: false,
                message: 'Uploads temporarily disabled due to server maintenance'
            };
        }

        if (!file.name.toLowerCase().endsWith('.stl')) {
            return { 
                valid: false, 
                message: 'Only .stl files are allowed.' 
            };
        }

        try {
            const isValidSTL = await validateSTLFile(file.data);
            if (!isValidSTL) {
                return {
                    valid: false,
                    message: 'Invalid STL file. Please upload a valid 3D model file.'
                };
            }
        } catch (error) {
            logger.error('STL validation error:', error);
            return {
                valid: false,
                message: 'File validation failed. Please try again with a simpler model.'
            };
        }

        return { valid: true };
    }
}));

// Clean up temp file after request using async/await
app.use(async (req, res, next) => {
    const cleanup = async () => {
        if (req.files) {
            await Promise.all(Object.values(req.files).map(async (file) => {
                if (file.tempFilePath && fsSync.existsSync(file.tempFilePath)) {
                    try {
                        await fs.unlink(file.tempFilePath);
                    } catch (err) {
                        logger.error('Error removing temp file:', err);
                    }
                }
            }));
        }
    };

    res.on('finish', () => {
        cleanup().catch(err => logger.error('Cleanup error:', err));
    });

    res.on('error', () => {
        cleanup().catch(err => logger.error('Cleanup error:', err));
    });

    next();
});

// Compression middleware
app.use(compression());

// Request logging middleware
app.use((req, res, next) => {
    logger.info({
        method: req.method,
        path: req.path,
        ip: req.ip
    });
    next();
});

// Serve static files with improved caching
app.use(express.static(__dirname, {
    maxAge: '1d',
    setHeaders: (res, filePath) => {
        // Generate ETag based on file content
        const fileContent = fsSync.readFileSync(filePath);
        const etag = crypto.createHash('sha256').update(fileContent).digest('hex');
        res.setHeader('ETag', `"${etag}"`);
        
        // Set strict security headers
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-XSS-Protection', '1; mode=block');
        
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (filePath.match(/\.(js|css|jpg|png|gif)$/)) {
            res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
            // Add subresource integrity for scripts and styles
            if (filePath.match(/\.(js|css)$/)) {
                const hash = crypto.createHash('sha384').update(fileContent).digest('base64');
                res.setHeader('Integrity', `sha384-${hash}`);
            }
        }
    }
}));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, process.env.UPLOAD_PATH || 'uploads');
if (!require('fs').existsSync(uploadsDir)) {
    require('fs').mkdirSync(uploadsDir, { recursive: true });
}

// CORS middleware for development
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Add upload endpoint with additional security
app.post('/upload', async (req, res) => {
    try {
        if (!req.files || !req.files.model) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const file = req.files.model;

        // Additional validation here if needed
        // Process file...

        res.json({ success: true });
    } catch (error) {
        logger.error('Upload error:', error);
        res.status(500).json({ error: 'File upload failed' });
    }
});

// Handle all routes by serving index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    logger.error({
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
        path: req.path,
        method: req.method
    });

    res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'production' 
            ? 'An error occurred' 
            : err.message
    });
});

// Start server with proper error handling
const server = app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
})
.on('error', (err) => {
    logger.error('Server failed to start:', err);
    process.exit(1);
});

// Set server timeouts
server.timeout = 30000; // 30 second timeout
server.keepAliveTimeout = 30000;
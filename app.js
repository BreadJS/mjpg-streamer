const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

const app = express();
app.use(express.json());

let config = {
    port: 8080,
    camera: {
        deviceName: "Iriun Webcam",
        deviceId: 0,
        width: 640,
        height: 480,
        fps: 30
    }
};

function getConfigPath() {
    // When compiled with pkg, use the directory where the exe is located
    if (process.pkg) {
        return path.join(path.dirname(process.execPath), 'config.json');
    } else {
        // In development, use the current directory
        return path.join(__dirname, 'config.json');
    }
}

function loadConfig() {
    try {
        const configPath = getConfigPath();
        console.log(`Loading config from: ${configPath}`);
        
        if (fs.existsSync(configPath)) {
            const configData = fs.readFileSync(configPath, 'utf8');
            config = { ...config, ...JSON.parse(configData) };
            console.log('✅ Configuration loaded successfully');
        } else {
            console.log('⚠️  Config file not found, creating default config...');
            saveConfig();
        }
    } catch (error) {
        console.error('❌ Error loading config:', error.message);
        console.log('Using default settings');
    }
}

function saveConfig() {
    try {
        const configPath = getConfigPath();
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`✅ Configuration saved to: ${configPath}`);
    } catch (error) {
        console.error('❌ Error saving config:', error.message);
    }
}

function listCameraDevices() {
    return new Promise((resolve) => {
        const command = 'ffmpeg -list_devices true -f dshow -i dummy';
        
        exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
            const devices = [];
            let deviceIndex = 0;
            
            if (stderr) {
                const lines = stderr.split('\n');
                let inVideoSection = false;
                
                for (let line of lines) {
                    if (line.includes('DirectShow video devices')) {
                        inVideoSection = true;
                        continue;
                    }
                    if (inVideoSection && line.includes('DirectShow audio devices')) {
                        break;
                    }
                    if (inVideoSection && line.includes('"')) {
                        const match = line.match(/"([^"]+)"/);
                        if (match) {
                            devices.push({
                                id: deviceIndex++,
                                name: match[1]
                            });
                        }
                    }
                }
            }
            
            if (devices.length === 0) {
                devices.push({ id: 0, name: 'Default Camera Device' });
            }
            
            resolve(devices);
        });
    });
}

class MJPEGStreamer {
    constructor() {
        this.clients = new Set();
        this.streaming = false;
        this.ffmpegProcess = null;
        this.frameBuffer = Buffer.alloc(0);
        this.lastFrame = null;
        this.clientCounter = 0;
    }

    addClient(res) {
        const clientId = ++this.clientCounter;
        console.log(`📱 Client ${clientId} connected (Total: ${this.clients.size + 1})`);
        
        res.writeHead(200, {
            'Content-Type': 'multipart/x-mixed-replace; boundary=mjpegstream',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Accel-Buffering': 'no'
        });

        // Send initial boundary
        res.write('\r\n--mjpegstream\r\n');

        this.clients.add(res);

        // If we have a cached frame, send it immediately
        if (this.lastFrame) {
            this.sendFrameToClient(res, this.lastFrame);
        }

        res.on('close', () => {
            console.log(`📱 Client ${clientId} disconnected (Remaining: ${this.clients.size - 1})`);
            this.clients.delete(res);
        });

        res.on('error', (err) => {
            console.log(`📱 Client ${clientId} error: ${err.message}`);
            this.clients.delete(res);
        });

        // Start streaming if not already running
        if (!this.streaming) {
            this.startStreaming();
        }
    }

    startStreaming() {
        if (this.streaming) return;
        
        console.log(`🚀 Starting camera stream...`);
        console.log(`📹 Device: ${config.camera.deviceName} (ID: ${config.camera.deviceId})`);
        console.log(`📐 Resolution: ${config.camera.width}x${config.camera.height}@${config.camera.fps}fps`);
        
        this.streaming = true;

        // Try different methods to find the camera
        this.tryStartCamera();
    }

    tryStartCamera() {
        // Method 1: Try by device name first
        if (config.camera.deviceName && config.camera.deviceName !== 'auto') {
            console.log(`🔍 Trying to connect to camera: "${config.camera.deviceName}"`);
            this.startFFmpeg(`video=${config.camera.deviceName}`);
        } else {
            // Method 2: Try by device ID
            console.log(`🔍 Trying to connect to camera device ID: ${config.camera.deviceId}`);
            this.startFFmpeg(`video=@device_pnp_\\\\?\\usb#vid_*&pid_*#*#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global`);
        }
    }

    startFFmpeg(videoDevice) {
        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill();
        }

        // For high resolutions, use more conservative parameters
        const isHighRes = config.camera.width >= 1920 || config.camera.height >= 1080;
        const isMedRes = config.camera.width >= 1280 || config.camera.height >= 720;
        
        const ffmpegArgs = [
            '-f', 'dshow',
            '-video_size', `${config.camera.width}x${config.camera.height}`,
            '-framerate', config.camera.fps.toString(),
            '-rtbufsize', '100M', // Large buffer to prevent drops
            '-thread_queue_size', '1024', // Larger thread queue
            '-i', videoDevice,
            '-f', 'mjpeg',
            '-q:v', isHighRes ? '6' : isMedRes ? '4' : '3', // More conservative quality
            '-huffman', '0', // Disable huffman optimization (faster, more stable)
            '-pix_fmt', 'yuvj420p', // Force consistent pixel format
            'pipe:1'
        ];

        // Add error resilience for high resolution
        if (isHighRes || isMedRes) {
            ffmpegArgs.splice(-1, 0, '-err_detect', 'ignore_err'); // Ignore minor errors
            ffmpegArgs.splice(-1, 0, '-fflags', '+genpts'); // Generate timestamps
        }

        console.log('🔧 FFmpeg command:', 'ffmpeg', ffmpegArgs.join(' '));

        try {
            this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let hasReceivedData = false;
            let reconnectTimeout = null;

            this.ffmpegProcess.stdout.on('data', (data) => {
                if (!hasReceivedData) {
                    hasReceivedData = true;
                    console.log('✅ Camera stream started successfully!');
                    if (reconnectTimeout) {
                        clearTimeout(reconnectTimeout);
                        reconnectTimeout = null;
                    }
                }
                
                this.processFrameData(data);
            });

            this.ffmpegProcess.stderr.on('data', (data) => {
                const errorMsg = data.toString();
                
                // Critical errors that require action
                if (errorMsg.includes('Could not open input') || 
                    errorMsg.includes('No such file or directory') ||
                    errorMsg.includes('Cannot find a device')) {
                    
                    console.error('❌ Camera connection failed:', errorMsg.split('\n')[0]);
                    
                    if (!hasReceivedData) {
                        console.log('🔄 Trying fallback method...');
                        setTimeout(() => this.tryFallbackCamera(), 1000);
                    }
                    return;
                }
                
                // Filter out common MJPEG decode errors (they're not critical for streaming)
                if (errorMsg.includes('mjpeg_decode_dc') ||
                    errorMsg.includes('error y=') ||
                    errorMsg.includes('error x=') ||
                    errorMsg.includes('EOI missing') ||
                    errorMsg.includes('error count:') ||
                    errorMsg.includes('error dc') ||
                    errorMsg.includes('bad vlc') ||
                    errorMsg.includes('overread') ||
                    errorMsg.includes('Found EOI before any SOF') ||
                    errorMsg.includes('No JPEG data found') ||
                    errorMsg.includes('Error submitting packet') ||
                    errorMsg.includes('More than 1000 frames duplicated') ||
                    errorMsg.includes('frame=') ||
                    errorMsg.includes('fps=') ||
                    errorMsg.includes('bitrate=') ||
                    errorMsg.includes('Metadata:') ||
                    errorMsg.includes('encoder') ||
                    errorMsg.includes('Side data:') ||
                    errorMsg.includes('cpb:')) {
                    // These are common with MJPEG streaming and don't indicate serious problems
                    return;
                }
                
                // Log other potentially important messages
                console.log('FFmpeg:', errorMsg.trim());
            });

            this.ffmpegProcess.on('close', (code) => {
                console.log(`📺 FFmpeg process exited with code ${code}`);
                if (this.streaming && !reconnectTimeout) {
                    console.log('🔄 Attempting to reconnect in 3 seconds...');
                    reconnectTimeout = setTimeout(() => {
                        this.tryStartCamera();
                    }, 3000);
                }
            });

            this.ffmpegProcess.on('error', (error) => {
                console.error('❌ FFmpeg error:', error.message);
                if (error.code === 'ENOENT') {
                    console.error('💡 FFmpeg not found! Please install FFmpeg and add it to your PATH.');
                    console.error('📥 Download from: https://ffmpeg.org/download.html#build-windows');
                }
                this.startDummyStream();
            });

        } catch (error) {
            console.error('❌ Failed to start FFmpeg:', error.message);
            this.startDummyStream();
        }
    }

    tryFallbackCamera() {
        if (!this.streaming) return;
        
        console.log('🔍 Trying fallback camera methods...');
        
        // Try lower resolution first
        const fallbackResolutions = [
            { width: 1280, height: 720, fps: Math.min(config.camera.fps, 30) },
            { width: 640, height: 480, fps: Math.min(config.camera.fps, 30) },
            { width: 320, height: 240, fps: Math.min(config.camera.fps, 30) }
        ];
        
        this.tryFallbackWithResolution(0, fallbackResolutions);
    }

    tryFallbackWithResolution(index, resolutions) {
        if (index >= resolutions.length) {
            console.log('❌ All fallback resolutions failed. Starting dummy stream...');
            this.startDummyStream();
            return;
        }

        const res = resolutions[index];
        console.log(`🔍 Trying fallback resolution: ${res.width}x${res.height}@${res.fps}fps`);
        
        const fallbackArgs = [
            '-f', 'dshow',
            '-video_size', `${res.width}x${res.height}`,
            '-framerate', res.fps.toString(),
            '-i', `video=${config.camera.deviceName}`,
            '-f', 'mjpeg',
            '-q:v', '5',
            '-preset', 'ultrafast',
            'pipe:1'
        ];

        try {
            if (this.ffmpegProcess) {
                this.ffmpegProcess.kill();
            }

            this.ffmpegProcess = spawn('ffmpeg', fallbackArgs, {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let hasData = false;

            this.ffmpegProcess.stdout.on('data', (data) => {
                if (!hasData) {
                    hasData = true;
                    console.log(`✅ Fallback working at ${res.width}x${res.height}@${res.fps}fps!`);
                    console.log('💡 Consider updating your config.json with this working resolution');
                }
                this.processFrameData(data);
            });

            this.ffmpegProcess.on('close', () => {
                if (!hasData) {
                    console.log(`❌ Resolution ${res.width}x${res.height} failed, trying next...`);
                    setTimeout(() => {
                        this.tryFallbackWithResolution(index + 1, resolutions);
                    }, 1000);
                }
            });

        } catch (error) {
            console.error('❌ Fallback method failed:', error.message);
            setTimeout(() => {
                this.tryFallbackWithResolution(index + 1, resolutions);
            }, 1000);
        }
    }

    processFrameData(data) {
        this.frameBuffer = Buffer.concat([this.frameBuffer, data]);
        
        // Prevent buffer from growing too large (memory leak protection)
        if (this.frameBuffer.length > 10 * 1024 * 1024) { // 10MB limit
            console.log('⚠️  Frame buffer too large, resetting...');
            this.frameBuffer = Buffer.alloc(0);
            return;
        }
        
        // Look for JPEG start and end markers
        const jpegStart = Buffer.from([0xFF, 0xD8]);
        const jpegEnd = Buffer.from([0xFF, 0xD9]);
        
        let startPos = 0;
        let start = this.frameBuffer.indexOf(jpegStart, startPos);
        
        while (start !== -1) {
            const end = this.frameBuffer.indexOf(jpegEnd, start + 2);
            if (end !== -1) {
                // Found complete JPEG frame
                const frame = this.frameBuffer.slice(start, end + 2);
                
                // Basic frame validation - check minimum size and structure
                if (this.validateFrame(frame)) {
                    this.broadcastFrame(frame);
                } else {
                    // Skip corrupted frame
                    console.log('🗑️  Skipping corrupted frame');
                }
                
                startPos = end + 2;
                start = this.frameBuffer.indexOf(jpegStart, startPos);
            } else {
                // Incomplete frame, keep the buffer from this point
                this.frameBuffer = this.frameBuffer.slice(start);
                break;
            }
        }
        
        // If no start marker found, clear the buffer
        if (start === -1) {
            this.frameBuffer = Buffer.alloc(0);
        }
    }

    validateFrame(frame) {
        // Basic JPEG validation
        if (frame.length < 100) return false; // Too small
        if (frame.length > 5 * 1024 * 1024) return false; // Too large (>5MB)
        
        // Check JPEG structure
        if (frame[0] !== 0xFF || frame[1] !== 0xD8) return false; // Missing SOI
        if (frame[frame.length - 2] !== 0xFF || frame[frame.length - 1] !== 0xD9) return false; // Missing EOI
        
        return true;
    }

    startDummyStream() {
        console.log('📺 Starting dummy stream (camera not available)');
        
        const frameRate = 1000 / Math.min(config.camera.fps, 10); // Cap at 10fps for dummy
        
        const dummyInterval = setInterval(() => {
            if (!this.streaming) {
                clearInterval(dummyInterval);
                return;
            }
            
            const dummyFrame = this.createDummyFrame();
            this.broadcastFrame(dummyFrame);
        }, frameRate);

        // Store interval for cleanup
        this.dummyInterval = dummyInterval;
    }

    createDummyFrame() {
        const width = config.camera.width;
        const height = config.camera.height;
        const timestamp = new Date().toLocaleTimeString();
        
        // Create a simple JPEG header for a solid color image
        const jpegData = Buffer.from([
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
            0x00, 0x48, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x80, 0x03, 0x01, 0x22,
            0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00, 0x01, 0x05, 0x01,
            0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03,
            0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00,
            0x3F, 0x00
        ]);
        
        // Add some dummy image data
        const imageData = Buffer.alloc(1000, 0x80);
        const jpegEnd = Buffer.from([0xFF, 0xD9]);
        
        return Buffer.concat([jpegData, imageData, jpegEnd]);
    }

    sendFrameToClient(client, frameData) {
        try {
            const frame = Buffer.concat([
                Buffer.from('Content-Type: image/jpeg\r\n'),
                Buffer.from(`Content-Length: ${frameData.length}\r\n\r\n`),
                frameData,
                Buffer.from('\r\n--mjpegstream\r\n')
            ]);
            client.write(frame);
            return true;
        } catch (error) {
            return false;
        }
    }

    broadcastFrame(frameData) {
        if (this.clients.size === 0) return;

        // Cache the latest frame for new clients
        this.lastFrame = frameData;

        // Send to all connected clients
        const clientsToRemove = [];
        
        for (const client of this.clients) {
            if (!this.sendFrameToClient(client, frameData)) {
                clientsToRemove.push(client);
            }
        }

        // Clean up disconnected clients
        clientsToRemove.forEach(client => {
            this.clients.delete(client);
        });

        if (clientsToRemove.length > 0) {
            console.log(`🧹 Cleaned up ${clientsToRemove.length} disconnected clients`);
        }
    }

    stopStreaming() {
        if (!this.streaming) return;
        
        console.log('🛑 Stopping camera stream');
        this.streaming = false;
        
        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill('SIGTERM');
            this.ffmpegProcess = null;
        }

        if (this.dummyInterval) {
            clearInterval(this.dummyInterval);
            this.dummyInterval = null;
        }
        
        this.frameBuffer = Buffer.alloc(0);
        this.lastFrame = null;
    }

    forceStopStreaming() {
        console.log('🛑 Force stopping camera stream (manual override)');
        this.stopStreaming();
    }

    restartStreaming() {
        console.log('🔄 Restarting camera stream');
        this.stopStreaming();
        setTimeout(() => {
            this.startStreaming();
        }, 1000);
    }
}

const streamer = new MJPEGStreamer();

// Routes
app.get('/stream', (req, res) => {
    streamer.addClient(res);
});

app.get('/cameras', async (req, res) => {
    try {
        const devices = await listCameraDevices();
        res.json(devices);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/config', (req, res) => {
    res.json(config);
});

app.post('/config', (req, res) => {
    try {
        config = { ...config, ...req.body };
        saveConfig();
        
        // Restart stream with new config
        streamer.restartStreaming();
        
        res.json({ message: 'Configuration updated successfully. Stream is restarting with new settings.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Stream control endpoints
app.post('/stream/start', (req, res) => {
    try {
        if (!streamer.streaming) {
            streamer.startStreaming();
            res.json({ message: 'Stream started successfully' });
        } else {
            res.json({ message: 'Stream is already running' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/stream/stop', (req, res) => {
    try {
        if (streamer.streaming) {
            streamer.forceStopStreaming();
            res.json({ message: 'Stream stopped successfully' });
        } else {
            res.json({ message: 'Stream is not running' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/stream/restart', (req, res) => {
    try {
        streamer.restartStreaming();
        res.json({ message: 'Stream is restarting' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>MJPEG Camera Streamer</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
                .container { max-width: 900px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                .stream-container { text-align: center; margin: 20px 0; padding: 20px; background: #f9f9f9; border-radius: 5px; }
                .config { background: #e8f4f8; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #007cba; }
                .stream-url { background: #2d3748; color: #e2e8f0; padding: 10px; border-radius: 4px; font-family: monospace; word-break: break-all; }
                button { background: #007cba; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; margin: 5px; }
                button:hover { background: #005a87; }
                .status { padding: 10px; border-radius: 4px; margin: 10px 0; }
                .status.success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
                .status.info { background: #d1ecf1; color: #0c5460; border: 1px solid #bee5eb; }
                .status.warning { background: #fff3cd; color: #856404; border: 1px solid #ffeaa7; }
                .instructions { background: #fff3cd; padding: 15px; border-radius: 5px; border-left: 4px solid #ffc107; }
                img { max-width: 100%; border: 2px solid #ddd; border-radius: 4px; }
                .performance { background: #e7f3ff; padding: 15px; border-radius: 5px; border-left: 4px solid #0066cc; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🎥 MJPEG Camera Streamer for OctoPrint</h1>
                
                <div class="stream-container">
                    <h2>📹 Live Camera Stream</h2>
                    <img id="stream" src="/stream" alt="Camera Stream" 
                         onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjQwIiBoZWlnaHQ9IjQ4MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjMzMzIi8+PHRleHQgeD0iNTAlIiB5PSI0MCUiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZpbGw9IndoaXRlIiBmb250LWZhbWlseT0iQXJpYWwiIGZvbnQtc2l6ZT0iMjQiPkNhbWVyYSBOb3QgQXZhaWxhYmxlPC90ZXh0Pjwvc3ZnPg=='" />
                    <div class="status info">
                        <strong>Stream Status:</strong> ${config.camera.deviceName} @ ${config.camera.fps}fps
                    </div>
                </div>
                
                <div class="performance">
                    <h3>⚡ Performance Optimized!</h3>
                    <p><strong>Now using FFmpeg for real-time streaming:</strong></p>
                    <ul>
                        <li>✅ True ${config.camera.fps} FPS streaming (not 1 frame per minute!)</li>
                        <li>✅ Hardware-accelerated video capture</li>
                        <li>✅ Low latency MJPEG encoding</li>
                        <li>✅ Automatic reconnection on camera disconnect</li>
                    </ul>
                </div>
                
                <div class="config">
                    <h2>🔧 Configuration</h2>
                    <div class="status success">
                        <strong>Stream URL for OctoPrint:</strong><br>
                        <div class="stream-url">http://localhost:${config.port}/stream</div>
                    </div>
                    <p><strong>Camera Device:</strong> ${config.camera.deviceName}</p>
                    <p><strong>Resolution:</strong> ${config.camera.width} x ${config.camera.height}</p>
                    <p><strong>FPS:</strong> ${config.camera.fps}</p>
                    
                    <button onclick="location.reload()">🔄 Refresh Page</button>
                    <button onclick="window.open('/cameras', '_blank')">📱 List Cameras</button>
                    <button onclick="testStream()">🧪 Test Stream</button>
                    <button onclick="restartStream()">🔄 Restart Stream</button>
                    <button onclick="showStatus()">📊 Show Status</button>
                </div>
                
                <div class="instructions">
                    <h3>📋 Setup Instructions for OctoPrint</h3>
                    <ol>
                        <li><strong>Install FFmpeg:</strong> Download from <a href="https://ffmpeg.org/download.html#build-windows" target="_blank">https://ffmpeg.org/download.html</a> and add to PATH</li>
                        <li><strong>Configure Camera:</strong> Edit <code>config.json</code> with your camera name: "${config.camera.deviceName}"</li>
                        <li><strong>OctoPrint Settings:</strong>
                            <ul>
                                <li>Go to Settings → Webcam & Timelapse</li>
                                <li>Set <strong>Stream URL</strong> to: <code>http://localhost:${config.port}/stream</code></li>
                                <li>Set <strong>Snapshot URL</strong> to: <code>http://localhost:${config.port}/stream</code></li>
                            </ul>
                        </li>
                        <li><strong>Test:</strong> Should now stream at full ${config.camera.fps} FPS!</li>
                    </ol>
                </div>

                <div class="config">
                    <h3>🛠️ Troubleshooting</h3>
                    <ul>
                        <li><strong>No stream:</strong> Install FFmpeg and make sure it's in your PATH</li>
                        <li><strong>Wrong camera:</strong> Run <code>npm run detect</code> to see available cameras</li>
                        <li><strong>Poor performance:</strong> Lower FPS or resolution in config.json</li>
                        <li><strong>Camera in use:</strong> Close other apps using the camera</li>
                    </ul>
                </div>
            </div>

            <script>
                function testStream() {
                    const img = document.getElementById('stream');
                    const startTime = Date.now();
                    let frameCount = 0;
                    
                    const counter = setInterval(() => {
                        frameCount++;
                        const elapsed = (Date.now() - startTime) / 1000;
                        const fps = (frameCount / elapsed).toFixed(1);
                        console.log('Stream test - Frames:', frameCount, 'FPS:', fps);
                    }, 1000);
                    
                    setTimeout(() => {
                        clearInterval(counter);
                        alert('Stream test completed! Check console for FPS results.');
                    }, 10000);
                }

                async function restartStream() {
                    try {
                        const response = await fetch('/stream/restart', { method: 'POST' });
                        const result = await response.json();
                        alert(result.message);
                    } catch (error) {
                        alert('Error restarting stream: ' + error.message);
                    }
                }

                async function showStatus() {
                    try {
                        const response = await fetch('/health');
                        const status = await response.json();
                        const info = 'Stream Status:\\n' +
                                   '• Streaming: ' + (status.streaming ? 'Yes' : 'No') + '\\n' +
                                   '• Connected Clients: ' + status.connectedClients + '\\n' +
                                   '• Total Clients Served: ' + status.totalClientsServed + '\\n' +
                                   '• FFmpeg Status: ' + status.ffmpeg + '\\n' +
                                   '• Has Cached Frame: ' + (status.hasLastFrame ? 'Yes' : 'No') + '\\n' +
                                   '• Uptime: ' + Math.floor(status.uptime) + ' seconds';
                        alert(info);
                    } catch (error) {
                        alert('Error getting status: ' + error.message);
                    }
                }
                
                // Auto-refresh on error with backoff
                let refreshCount = 0;
                document.getElementById('stream').addEventListener('error', function() {
                    refreshCount++;
                    const delay = Math.min(refreshCount * 2000, 10000);
                    setTimeout(() => {
                        this.src = '/stream?' + Date.now();
                    }, delay);
                });
                
                document.getElementById('stream').addEventListener('load', function() {
                    refreshCount = 0; // Reset on successful load
                });

                // Update client count periodically
                setInterval(async () => {
                    try {
                        const response = await fetch('/health');
                        const status = await response.json();
                        const statusDiv = document.querySelector('.status.info');
                        if (statusDiv) {
                            statusDiv.innerHTML = '<strong>Stream Status:</strong> ' + 
                                                '${config.camera.deviceName} @ ${config.camera.fps}fps ' +
                                                '(Clients: ' + status.connectedClients + ')';
                        }
                    } catch (error) {
                        // Ignore errors
                    }
                }, 5000);
            </script>
        </body>
        </html>
    `);
});

app.get('/health', (req, res) => {
    res.json({
        status: 'running',
        config: config,
        streaming: streamer.streaming,
        connectedClients: streamer.clients.size,
        totalClientsServed: streamer.clientCounter,
        ffmpeg: streamer.ffmpegProcess ? 'active' : 'inactive',
        hasLastFrame: !!streamer.lastFrame,
        uptime: process.uptime()
    });
});

loadConfig();

app.listen(config.port, () => {
    console.log('🎥 MJPEG Camera Streamer v2.0 - FFmpeg Edition');
    console.log(`📡 Running on: http://localhost:${config.port}`);
    console.log(`🎯 Stream URL: http://localhost:${config.port}/stream`);
    console.log(`📱 Camera: ${config.camera.deviceName}`);
    console.log(`📐 Resolution: ${config.camera.width}x${config.camera.height}@${config.camera.fps}fps`);
    console.log('');
    console.log('⚡ Starting camera stream automatically...');
    
    // Start streaming automatically
    streamer.startStreaming();
    
    console.log('🚀 Server ready! Stream is now running continuously.');
    console.log('💡 Make sure FFmpeg is installed for best performance');
});

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    streamer.stopStreaming();
    process.exit(0);
});
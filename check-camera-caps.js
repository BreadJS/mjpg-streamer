const { exec } = require('child_process');

function checkCameraCapabilities(deviceName) {
    return new Promise((resolve, reject) => {
        console.log(`🔍 Checking capabilities for: ${deviceName}`);
        
        const command = `ffmpeg -f dshow -list_options true -i video="${deviceName}"`;
        
        exec(command, { timeout: 15000 }, (error, stdout, stderr) => {
            const capabilities = {
                device: deviceName,
                supportedFormats: [],
                recommendedSettings: []
            };
            
            if (stderr) {
                const lines = stderr.split('\n');
                let inVideoOptions = false;
                
                for (let line of lines) {
                    if (line.includes('DirectShow video device options')) {
                        inVideoOptions = true;
                        continue;
                    }
                    
                    if (inVideoOptions) {
                        // Parse resolution and fps info
                        const resMatch = line.match(/(\d+)x(\d+)/);
                        const fpsMatch = line.match(/(\d+(?:\.\d+)?)\s*fps/);
                        const formatMatch = line.match(/(yuyv422|nv12|mjpeg|rgb24)/i);
                        
                        if (resMatch && fpsMatch) {
                            const width = parseInt(resMatch[1]);
                            const height = parseInt(resMatch[2]);
                            const fps = parseFloat(fpsMatch[1]);
                            const format = formatMatch ? formatMatch[1].toLowerCase() : 'unknown';
                            
                            capabilities.supportedFormats.push({
                                width: width,
                                height: height,
                                fps: fps,
                                format: format
                            });
                        }
                    }
                }
                
                // Create recommendations
                const formats = capabilities.supportedFormats;
                
                // Find common resolutions
                const common1080p = formats.find(f => f.width === 1920 && f.height === 1080);
                const common720p = formats.find(f => f.width === 1280 && f.height === 720);
                const common480p = formats.find(f => f.width === 640 && f.height === 480);
                
                if (common1080p) {
                    capabilities.recommendedSettings.push({
                        name: "1080p High Quality",
                        width: 1920,
                        height: 1080,
                        fps: Math.min(common1080p.fps, 30),
                        note: "Best quality, requires more bandwidth"
                    });
                }
                
                if (common720p) {
                    capabilities.recommendedSettings.push({
                        name: "720p Balanced",
                        width: 1280,
                        height: 720,
                        fps: Math.min(common720p.fps, 30),
                        note: "Good balance of quality and performance"
                    });
                }
                
                if (common480p) {
                    capabilities.recommendedSettings.push({
                        name: "480p Performance",
                        width: 640,
                        height: 480,
                        fps: Math.min(common480p.fps, 30),
                        note: "Lower bandwidth, good for slow connections"
                    });
                }
            }
            
            resolve(capabilities);
        });
    });
}

async function main() {
    const config = require('./config.json');
    const deviceName = config.camera.deviceName;
    
    if (!deviceName || deviceName === 'auto') {
        console.error('❌ Please set a specific camera device name in config.json first');
        console.error('💡 Run "npm run detect" to see available cameras');
        process.exit(1);
    }
    
    try {
        console.log('🎥 Camera Capability Checker');
        console.log('============================');
        console.log('');
        
        const caps = await checkCameraCapabilities(deviceName);
        
        console.log(`📹 Device: ${caps.device}`);
        console.log('');
        
        if (caps.supportedFormats.length > 0) {
            console.log('✅ Supported Formats:');
            console.log('=====================');
            caps.supportedFormats.forEach((format, index) => {
                console.log(`${index + 1}. ${format.width}x${format.height} @ ${format.fps}fps (${format.format})`);
            });
            console.log('');
        }
        
        if (caps.recommendedSettings.length > 0) {
            console.log('💡 Recommended Settings for config.json:');
            console.log('=========================================');
            caps.recommendedSettings.forEach((setting, index) => {
                console.log(`${index + 1}. ${setting.name}:`);
                console.log(`   "width": ${setting.width},`);
                console.log(`   "height": ${setting.height},`);
                console.log(`   "fps": ${setting.fps}`);
                console.log(`   // ${setting.note}`);
                console.log('');
            });
        }
        
        const currentConfig = config.camera;
        console.log('🔧 Current Config:');
        console.log('==================');
        console.log(`Resolution: ${currentConfig.width}x${currentConfig.height}`);
        console.log(`FPS: ${currentConfig.fps}`);
        console.log('');
        
        // Check if current config is supported
        const isSupported = caps.supportedFormats.some(f => 
            f.width === currentConfig.width && 
            f.height === currentConfig.height && 
            f.fps >= currentConfig.fps
        );
        
        if (isSupported) {
            console.log('✅ Your current configuration appears to be supported!');
        } else {
            console.log('⚠️  Your current configuration might not be supported.');
            console.log('💡 Try one of the recommended settings above.');
        }
        
    } catch (error) {
        console.error('❌ Error checking camera capabilities:', error.message);
        console.log('💡 Make sure FFmpeg is installed and the camera is not in use by another application');
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { checkCameraCapabilities };
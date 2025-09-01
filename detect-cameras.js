const { exec } = require('child_process');

console.log('🔍 Detecting camera devices on Windows...\n');

// Method 1: PowerShell WMI Query
function detectWithWMI() {
    return new Promise((resolve) => {
        const command = `powershell "Get-CimInstance -ClassName Win32_PnPEntity | Where-Object {$_.Name -match 'Camera' -or $_.Name -match 'Webcam' -or $_.Name -match 'USB Video' -or $_.Name -match 'Integrated Camera'} | Select-Object Name, DeviceID, Status | Format-Table -AutoSize"`;
        
        exec(command, (error, stdout, stderr) => {
            if (!error && stdout) {
                console.log('📱 Method 1: WMI Camera Detection');
                console.log('=====================================');
                console.log(stdout);
                console.log('');
            }
            resolve();
        });
    });
}

// Method 2: DirectShow Devices
function detectWithDirectShow() {
    return new Promise((resolve) => {
        // This requires ffmpeg to be installed
        const command = 'ffmpeg -list_devices true -f dshow -i dummy 2>&1 | findstr /C:"DirectShow video devices"';
        
        exec(command, (error, stdout, stderr) => {
            if (stderr && stderr.includes('DirectShow')) {
                console.log('📹 Method 2: DirectShow Video Devices (FFmpeg)');
                console.log('=============================================');
                const lines = stderr.split('\n');
                let foundDevices = false;
                let deviceIndex = 0;
                
                for (let line of lines) {
                    if (line.includes('DirectShow video devices')) {
                        foundDevices = true;
                        continue;
                    }
                    if (foundDevices && line.includes('"')) {
                        const match = line.match(/"([^"]+)"/);
                        if (match) {
                            console.log(`  Device ${deviceIndex}: ${match[1]}`);
                            deviceIndex++;
                        }
                    }
                    if (foundDevices && line.includes('DirectShow audio devices')) {
                        break;
                    }
                }
                if (deviceIndex === 0) {
                    console.log('  No DirectShow devices found or FFmpeg not installed');
                }
                console.log('');
            }
            resolve();
        });
    });
}

// Method 3: Device Manager Query
function detectWithDeviceManager() {
    return new Promise((resolve) => {
        const command = `powershell "Get-PnpDevice -Class Camera,Image | Where-Object {$_.Status -eq 'OK'} | Select-Object FriendlyName, InstanceId | Format-Table -AutoSize"`;
        
        exec(command, (error, stdout, stderr) => {
            if (!error && stdout) {
                console.log('📸 Method 3: Device Manager Camera Class');
                console.log('=======================================');
                console.log(stdout);
            }
            resolve();
        });
    });
}

async function main() {
    await detectWithWMI();
    await detectWithDirectShow();
    await detectWithDeviceManager();
    
    console.log('💡 Configuration Tips:');
    console.log('======================');
    console.log('1. Look for devices with names like:');
    console.log('   - "USB Video Device"');
    console.log('   - "Integrated Camera"'); 
    console.log('   - "HD WebCam" or similar');
    console.log('');
    console.log('2. Update your config.json with:');
    console.log('   "deviceName": "USB Video Device"  (use actual name from above)');
    console.log('   OR');
    console.log('   "deviceId": 0  (0 for first camera, 1 for second, etc.)');
    console.log('');
    console.log('3. If you have multiple cameras, try different deviceId numbers (0, 1, 2...)');
    console.log('');
    console.log('4. Run "npm start" to test your camera configuration');
}

main().catch(console.error);
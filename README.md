# MJPEG Camera Streamer for OctoPrint

A simple Node.js application that streams camera feeds as MJPEG for use with OctoPrint on Windows.

## Features

- MJPEG streaming compatible with HTML `<img>` tags
- Configurable camera device, resolution, and FPS
- Camera device detection
- Web interface for monitoring
- Compiles to standalone .exe file

## Installation

1. Install Node.js (version 18 or higher)
2. Install dependencies:
   ```
   npm install
   ```

## Configuration

Edit `config.json` to configure your camera:

```json
{
  "port": 8080,
  "camera": {
    "deviceId": 0,
    "width": 640,
    "height": 480,
    "fps": 30
  }
}
```

- `port`: HTTP server port
- `deviceId`: Camera device ID (usually 0 for first camera)
- `width/height`: Camera resolution
- `fps`: Frames per second

## Usage

### Development Mode
```
npm start
```

### Build Executable
```
npm run build
```
This creates:
- `dist/mjpeg-streamer.exe` - Main streaming application
- `dist/detect-cameras.exe` - Camera detection utility

**Important:** When using the .exe files, place a `config.json` file in the same directory as the executable. The exe will automatically create a default config.json if one doesn't exist.

### Camera Device Detection
Visit `http://localhost:8080/cameras` to see available camera devices.

## OctoPrint Setup

1. In OctoPrint settings, go to "Webcam & Timelapse"
2. Set Stream URL to: `http://localhost:8080/stream`
3. Set Snapshot URL to: `http://localhost:8080/stream` (same as stream)

## Web Interface

Visit `http://localhost:8080` to:
- View live camera stream
- Monitor configuration
- Get OctoPrint integration instructions

## Requirements

- Windows 10/11
- USB camera or webcam
- FFmpeg (for optimal performance)

## Troubleshooting

1. **No camera detected**: Check if camera is properly connected and not used by another application
2. **Stream not working**: Verify camera permissions and try different device IDs
3. **Poor performance**: Adjust resolution and FPS in config.json

## API Endpoints

- `GET /stream` - MJPEG stream
- `GET /cameras` - List available cameras
- `GET /config` - Get current configuration
- `POST /config` - Update configuration

## License

MIT
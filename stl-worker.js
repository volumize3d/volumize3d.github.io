const { parentPort } = require('worker_threads');
const STLParser = require('stl-parser');

function validateGeometry(vertices, normals) {
    if (!vertices || vertices.length === 0) {
        throw new Error('Invalid STL: No vertices found');
    }
    
    if (vertices.length % 9 !== 0) {
        throw new Error('Invalid STL: Incomplete triangle data');
    }
    
    // Check for degenerate triangles
    for (let i = 0; i < vertices.length; i += 9) {
        const v1 = vertices.slice(i, i + 3);
        const v2 = vertices.slice(i + 3, i + 6);
        const v3 = vertices.slice(i + 6, i + 9);
        
        // Check if any vertices are identical (degenerate triangle)
        if (v1.every((v, idx) => v === v2[idx]) ||
            v2.every((v, idx) => v === v3[idx]) ||
            v3.every((v, idx) => v === v1[idx])) {
            throw new Error('Invalid STL: Contains degenerate triangles');
        }
    }
    
    return true;
}

// Handle messages from main thread
parentPort.on('message', (buffer) => {
    try {
        // Run CPU-intensive STL parsing in worker thread
        const parser = new STLParser();
        const result = parser.parse(buffer);
        
        // Validate the STL structure and geometry
        validateGeometry(result.vertices, result.normals);
        
        // Calculate model statistics
        const stats = {
            triangleCount: result.vertices.length / 9,
            isValid: true
        };
        
        // Send result back to main thread
        parentPort.postMessage(stats);
    } catch (error) {
        // Send detailed error back to main thread
        parentPort.postMessage({ 
            isValid: false, 
            error: error.message,
            details: error.stack
        });
    }
});
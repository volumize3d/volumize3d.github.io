// Theme handling
let scene, camera, renderer, model;

const colorMap = {
    red: 0xFF0000,
    orange: 0xFF8800,
    yellow: 0xFFFF00,
    green: 0x00FF00,
    blue: 0x0000FF,
    purple: 0x800080,
    brown: 0x8B4513,
    black: 0x000000,
    white: 0xFFFFFF
};

function initTheme() {
    const theme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    updateThemeIcon(theme);
}

function updateThemeIcon(theme) {
    const themeIcon = document.querySelector('.theme-toggle i');
    if (themeIcon) {
        themeIcon.className = theme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
    }
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeIcon(newTheme);
    updateBackground();
}

// 3D viewer setup
function setupScene() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
    renderer = new THREE.WebGLRenderer({ 
        antialias: true, 
        alpha: true,
        logarithmicDepthBuffer: true
    });
    
    // Main light from front-top-right
    const mainLight = new THREE.DirectionalLight(0xffffff, 1.0);
    mainLight.position.set(5, 5, 5);
    scene.add(mainLight);
    
    // Secondary lights for better visibility
    const backLight = new THREE.DirectionalLight(0xffffff, 0.5);
    backLight.position.set(-5, 5, -5);
    scene.add(backLight);
    
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
    fillLight.position.set(-5, -5, 5);
    scene.add(fillLight);
    
    // Strong ambient light to ensure models are visible
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    
    // Position camera further back and higher for better overview
    camera.position.set(5, 5, 7);
    camera.lookAt(0, 0, 0);
}

function updateBackground() {
    if (renderer) {
        const bgColor = getComputedStyle(document.documentElement)
            .getPropertyValue('--card-bg').trim();
        renderer.setClearColor(bgColor, 1);
    }
}

// File handling
function validateFile(file) {
    const maxSize = 50 * 1024 * 1024;
    if (file.size > maxSize) {
        throw new Error('File size must be less than 50MB');
    }
    if (!file.name.toLowerCase().endsWith('.stl')) {
        throw new Error('Only STL files are allowed');
    }
    return true;
}

async function loadSTL(file) {
    return new Promise((resolve, reject) => {
        const loader = new THREE.STLLoader();
        const reader = new FileReader();
        
        reader.onload = function(e) {
            try {
                console.log('Loading STL file:', file.name);
                const geometry = loader.parse(e.target.result);
                
                // Log geometry details for debugging
                console.log('Geometry loaded:', {
                    vertices: geometry.attributes.position.count,
                    triangles: geometry.attributes.position.count / 3,
                    hasNormals: geometry.attributes.normal !== undefined
                });
                
                // Validate geometry
                if (!geometry.attributes.position || geometry.attributes.position.count === 0) {
                    throw new Error('Invalid STL: Model contains no geometry');
                }
                
                if (geometry.attributes.position.count % 3 !== 0) {
                    throw new Error('Invalid STL: Model contains non-manifold geometry');
                }
                
                // Create material with better default settings
                const material = new THREE.MeshPhongMaterial({
                    color: colorMap[document.getElementById('color').value],
                    specular: 0x111111,
                    shininess: 30,
                    side: THREE.DoubleSide,
                    flatShading: false  // Change to false to remove faceted look
                });

                const mesh = new THREE.Mesh(geometry, material);
                mesh.userData.originalGeometry = geometry.clone();
                
                // Center the mesh
                geometry.computeBoundingBox();
                const boundingBox = geometry.boundingBox;
                const center = boundingBox.getCenter(new THREE.Vector3());
                geometry.translate(-center.x, -center.y, -center.z);
                
                // Get model size before any scaling
                const size = new THREE.Vector3();
                boundingBox.getSize(size);
                const maxDim = Math.max(size.x, size.y, size.z);
                
                console.log('Model dimensions:', {
                    width: size.x,
                    height: size.y,
                    depth: size.z,
                    maxDim: maxDim
                });
                
                // Calculate volume before any scaling
                const volume = calculateVolume(geometry);
                if (volume <= 0) {
                    throw new Error('Invalid STL: Model has zero or negative volume');
                }
                mesh.userData.volume = volume;
                
                // Scale for display only - scale after volume calculation
                const targetSize = 4; // Desired size in scene units
                const scale = targetSize / maxDim;
                mesh.scale.set(scale, scale, scale);
                
                // Compute normals after all geometry modifications
                geometry.computeVertexNormals();
                geometry.computeFaceNormals();
                
                // Set initial rotation for better view
                mesh.rotation.x = -Math.PI / 6;
                mesh.rotation.y = Math.PI / 4;
                
                resolve(mesh);
            } catch (error) {
                console.error('STL loading error:', error);
                reject(new Error(`Failed to load STL: ${error.message}`));
            }
        };
        
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsArrayBuffer(file);
    });
}

function calculateVolume(geometry) {
    let volume = 0;
    const positions = geometry.attributes.position.array;
    
    for (let i = 0; i < positions.length; i += 9) {
        const v1 = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
        const v2 = new THREE.Vector3(positions[i + 3], positions[i + 4], positions[i + 5]);
        const v3 = new THREE.Vector3(positions[i + 6], positions[i + 7], positions[i + 8]);
        
        // Skip degenerate triangles
        if (!isTriangleDegenerate(v1, v2, v3)) {
            volume += signedVolumeOfTriangle(v1, v2, v3);
        }
    }
    
    return Math.abs(volume);
}

function isTriangleDegenerate(v1, v2, v3) {
    const EPSILON = 1e-10;
    return v1.distanceTo(v2) < EPSILON || 
           v2.distanceTo(v3) < EPSILON || 
           v3.distanceTo(v1) < EPSILON;
}

function signedVolumeOfTriangle(p1, p2, p3) {
    return p1.dot(p2.cross(p3)) / 6.0;
}

// Initialize components
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    
    // Event listeners
    document.querySelector('.theme-toggle')?.addEventListener('click', toggleTheme);
    
    // File upload handling
    document.getElementById('fileUpload')?.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        const previewContainer = document.getElementById('previewContainer');
        
        if (file) {
            try {
                validateFile(file);
                previewContainer.innerHTML = '<div class="loading">Loading and validating 3D model...</div>';
                
                if (!scene) setupScene();
                if (model) scene.remove(model);
                
                model = await loadSTL(file);
                scene.add(model);
                
                renderer.setSize(previewContainer.clientWidth, previewContainer.clientWidth);
                updateBackground();
                
                previewContainer.innerHTML = '';
                previewContainer.appendChild(renderer.domElement);
                
                // Show model statistics
                const volumeDisplay = document.getElementById('volumeDisplay');
                const dimensionsDisplay = document.getElementById('dimensionsDisplay');
                if (volumeDisplay && dimensionsDisplay) {
                    // Convert to cm³ for display (divide by 1000)
                    const volumeInCm3 = (model.userData.volume / 1000).toFixed(2);
                    const triangles = model.geometry.attributes.position.count / 3;
                    const size = new THREE.Vector3();
                    model.userData.originalGeometry.computeBoundingBox();
                    model.userData.originalGeometry.boundingBox.getSize(size);
                    // Convert to mm and round to 2 decimal places
                    const width = size.x.toFixed(2);
                    const height = size.y.toFixed(2);
                    const depth = size.z.toFixed(2);
                    volumeDisplay.innerHTML = `${volumeInCm3} cm³ (${triangles.toLocaleString()} triangles)`;
                    dimensionsDisplay.innerHTML = `${width} × ${height} × ${depth} mm`;
                    updatePrice();
                }
                
                // Animation
                function animate() {
                    requestAnimationFrame(animate);
                    renderer.render(scene, camera);
                }
                animate();
                
                // Handle resize
                new ResizeObserver(() => {
                    if (renderer && previewContainer) {
                        const width = previewContainer.clientWidth;
                        camera.aspect = 1;
                        camera.updateProjectionMatrix();
                        renderer.setSize(width, width);
                    }
                }).observe(previewContainer);
                
                // Mouse controls
                setupMouseControls(previewContainer);
                
            } catch (error) {
                console.error('Error:', error);
                previewContainer.innerHTML = `
                    <div class="error-message">
                        <p><strong>Error loading model:</strong></p>
                        <p>${error.message}</p>
                        <p>Please ensure your STL file:</p>
                        <ul>
                            <li>Is a valid 3D model</li>
                            <li>Has proper geometry and dimensions</li>
                            <li>Is not corrupted</li>
                            <li>Uses reasonable units</li>
                        </ul>
                    </div>`;
                event.target.value = '';
            }
        }
    });
    
    // Add color change handler
    document.getElementById('color')?.addEventListener('change', (event) => {
        if (model) {
            const colorValue = colorMap[event.target.value];
            // Update the main material color
            model.material.color.setHex(colorValue);
            
            // Keep wireframe visible by not changing its color
            model.children.forEach(child => {
                if (child.material && child.material.wireframe) {
                    child.material.color.setHex(0xFFFFFF);
                }
            });
        }
    });

    // Initialize other UI components
    initializePricingOptions();
    initializeInfillSlider();
    setupCheckoutButton();

    // Add this to your DOMContentLoaded event listener
    document.getElementById('infill')?.addEventListener('input', (event) => {
        const value = event.target.value;
        document.getElementById('infillValue').textContent = `${value}%`;
        updatePrice();
    });

    document.getElementById('infill')?.addEventListener('input', (event) => {
        const value = event.target.value;
        const percent = (value - event.target.min) / (event.target.max - event.target.min) * 100;
        event.target.style.setProperty('--value', `${percent}%`);
        document.getElementById('infillValue').textContent = `${value}%`;
        updatePrice();
    });

    // Initialize slider appearance
    const infillSlider = document.getElementById('infill');
    if (infillSlider) {
        const initialValue = infillSlider.value;
        const percent = (initialValue - infillSlider.min) / (infillSlider.max - infillSlider.min) * 100;
        infillSlider.style.setProperty('--value', `${percent}%`);
    }
});

// UI Components setup
function setupMouseControls(container) {
    let isMouseDown = false;
    let previousMousePosition = { x: 0, y: 0 };
    
    container.addEventListener('mousedown', (e) => {
        isMouseDown = true;
        previousMousePosition = { x: e.clientX, y: e.clientY };
    });
    
    document.addEventListener('mouseup', () => isMouseDown = false);
    
    document.addEventListener('mousemove', (e) => {
        if (!isMouseDown || !model) return;
        const deltaMove = {
            x: e.clientX - previousMousePosition.x,
            y: e.clientY - previousMousePosition.y
        };
        model.rotation.y += deltaMove.x * 0.01;
        model.rotation.x += deltaMove.y * 0.01;
        previousMousePosition = { x: e.clientX, y: e.clientY };
    });

    // Add mouse wheel zoom
    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        
        const zoomSpeed = 0.1;
        const delta = e.deltaY > 0 ? 1 : -1;
        
        // Get current camera position vector
        const position = camera.position.clone();
        
        // Scale the position vector
        const factor = 1 + (delta * zoomSpeed);
        position.multiplyScalar(factor);
        
        // Apply zoom limits
        const minDistance = 2;
        const maxDistance = 50;
        const distance = position.length();
        
        if (distance >= minDistance && distance <= maxDistance) {
            camera.position.copy(position);
        }
        
        camera.lookAt(0, 0, 0);
    }, { passive: false });
}

function initializePricingOptions() {
    const options = document.querySelectorAll('.pricing-option');
    options.forEach(option => {
        option.addEventListener('click', () => {
            options.forEach(opt => opt.classList.remove('selected'));
            option.classList.add('selected');
            selectedPrice = parseFloat(option.dataset.price);
            updatePrice();
        });
    });
    options[0]?.classList.add('selected');
}

function initializeInfillSlider() {
    const slider = document.getElementById('infill');
    const valueDisplay = document.getElementById('infillValue');
    if (slider && valueDisplay) {
        slider.addEventListener('input', () => {
            valueDisplay.textContent = `${slider.value}%`;
            updatePrice();
        });
    }
}

function setupCheckoutButton() {
    document.getElementById('checkoutButton').addEventListener('click', () => {
        if (!model?.userData.volume) {
            alert('Please upload a 3D model first!');
            return;
        }

        const orderDetails = {
            material: document.getElementById('material').value,
            color: document.getElementById('color').value,
            infill: document.getElementById('infill').value,
            volume: Math.round(model.userData.volume),
            price: document.getElementById('priceDisplay').textContent,
            serviceLevel: document.querySelector('.pricing-option.selected h3').textContent
        };
        
        alert(`Thank you for your order!\n\nOrder Details:\n` +
            `Material: ${orderDetails.material}\n` +
            `Color: ${orderDetails.color}\n` +
            `Infill: ${orderDetails.infill}%\n` +
            `Volume: ${orderDetails.volume}cm³\n` +
            `Service Level: ${orderDetails.serviceLevel}\n` +
            `Price: $${orderDetails.price}\n\n` +
            `This is a demo site. In a real implementation, you would be redirected to checkout.`);
    });
}

// Price calculation
let selectedPrice = 0.10;

function updatePrice() {
    const volume = model?.userData.volume || 0;
    // Convert volume from mm³ to cm³ for pricing
    const volumeInCm3 = volume / 1000;
    const infillPercentage = document.getElementById('infill')?.value / 100 || 0.2;
    const price = (volumeInCm3 * selectedPrice * infillPercentage).toFixed(2);
    document.getElementById('priceDisplay').textContent = price;
}

// Material and color changes
document.getElementById('material')?.addEventListener('change', updatePrice);
document.getElementById('color')?.addEventListener('change', function(e) {
    if (model) {
        model.material.color.setStyle(e.target.value);
    }
});
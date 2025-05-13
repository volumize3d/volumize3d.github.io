# Volumize - 3D Printing Service Website

A static website for 3D printing services with real-time STL preview and price calculation.

## Project Structure

```
volumize-website
├── src
│   ├── assets
│   │   └── js
│   │       ├── model-viewer.js
│   │       └── script.js
│   ├── styles
│   │   └── styles.css
│   └── index.html
├── package.json
└── README.md
```

## Features
- STL file upload and 3D preview
- Real-time model volume calculation
- Dynamic pricing based on material, infill, and service level
- Responsive design with dark/light theme support
- Client-side file validation

## Deployment to GitHub Pages

1. Create a new repository on GitHub
2. Push this code to your repository
3. Go to Settings > Pages
4. Under "Source", select "main" branch and "/src" folder
5. Click Save

Your site will be published at `https://[username].github.io/[repository-name]`

## Local Development

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm start
```

The site will be available at `http://localhost:3000`

## Technologies Used
- Three.js for 3D model visualization
- Pure JavaScript for client-side functionality
- CSS3 with CSS Custom Properties for theming
- HTML5 for structure and semantics

## Security Features
- Client-side file validation
- Content Security Policy headers
- XSS protection
- Clickjacking protection
- MIME type sniffing protection

## License

This project is licensed under the MIT License. See the LICENSE file for more details.

## Acknowledgments

Thank you for using Volumize! We hope you enjoy creating your 3D-printed items.
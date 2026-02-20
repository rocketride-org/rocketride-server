/**
 * License Aggregation Script
 * 
 * Collects license information from all dependencies and creates
 * a combined THIRD_PARTY_LICENSES.txt file in ./dist
 * 
 * Sources:
 *   - npm packages (node_modules)
 *   - Python packages (pip)
 *   - vcpkg packages (C++ dependencies)
 *   - Java/Maven dependencies
 *   - Project packages
 * 
 * Usage:
 *   node scripts/licenses.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Paths
const PROJECT_ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const OUTPUT_FILE = path.join(DIST_DIR, 'THIRD_PARTY_LICENSES.md');

// ============================================================================
// Helpers
// ============================================================================

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return null;
    }
}

function findFiles(dir, filename, results = []) {
    if (!fs.existsSync(dir)) return results;
    
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
            findFiles(fullPath, filename, results);
        } else if (entry.name === filename) {
            results.push(fullPath);
        }
    }
    return results;
}

function findLicenseFile(dir) {
    const licenseNames = ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENCE', 'COPYING', 'license', 'license.txt'];
    for (const name of licenseNames) {
        const filePath = path.join(dir, name);
        if (fs.existsSync(filePath)) {
            return filePath;
        }
    }
    return null;
}

// ============================================================================
// License Collectors
// ============================================================================

function collectNpmLicenses() {
    console.log('Collecting npm licenses...');
    const licenses = [];
    
    try {
        // Use pnpm licenses command for accurate results
        const output = execSync('pnpm licenses list --json 2>nul', {
            encoding: 'utf8',
            cwd: PROJECT_ROOT,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        const pnpmLicenses = JSON.parse(output);
        for (const [licenseName, packages] of Object.entries(pnpmLicenses)) {
            for (const pkg of packages) {
                licenses.push({
                    name: pkg.name,
                    version: pkg.version || '',
                    license: licenseName,
                    homepage: pkg.repository || '',
                    licenseText: ''
                });
            }
        }
    } catch (e) {
        // Fallback to manual scanning
        console.log('  Warning: pnpm licenses failed, scanning node_modules...');
        
        const nodeModulesDir = path.join(PROJECT_ROOT, 'node_modules');
        if (fs.existsSync(nodeModulesDir)) {
            const packages = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
            for (const pkg of packages) {
                if (!pkg.isDirectory() || pkg.name.startsWith('.')) continue;
                
                if (pkg.name.startsWith('@')) {
                    const scopedDir = path.join(nodeModulesDir, pkg.name);
                    const scopedPkgs = fs.readdirSync(scopedDir, { withFileTypes: true });
                    for (const scopedPkg of scopedPkgs) {
                        if (scopedPkg.isDirectory()) {
                            const info = extractNpmLicense(path.join(scopedDir, scopedPkg.name), `${pkg.name}/${scopedPkg.name}`);
                            if (info) licenses.push(info);
                        }
                    }
                } else {
                    const info = extractNpmLicense(path.join(nodeModulesDir, pkg.name), pkg.name);
                    if (info) licenses.push(info);
                }
            }
        }
    }
    
    console.log(`  Found ${licenses.length} npm packages`);
    return licenses;
}

function extractNpmLicense(pkgDir, pkgName) {
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    const pkgJson = readJsonSafe(pkgJsonPath);
    if (!pkgJson) return null;
    
    const licenseFile = findLicenseFile(pkgDir);
    let licenseText = '';
    if (licenseFile) {
        try {
            licenseText = fs.readFileSync(licenseFile, 'utf8');
        } catch (e) {}
    }
    
    return {
        name: pkgName,
        version: pkgJson.version || 'unknown',
        license: pkgJson.license || 'unknown',
        homepage: pkgJson.homepage || pkgJson.repository?.url || '',
        licenseText: licenseText
    };
}

function collectPythonLicenses() {
    console.log('Collecting Python licenses...');
    const licenses = [];
    
    try {
        // Try to get pip list with license info
        const pipOutput = execSync('pip show --verbose $(pip list --format=freeze | cut -d= -f1) 2>/dev/null || pip list --format=json', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        // Parse pip list JSON
        const pipList = JSON.parse(pipOutput);
        for (const pkg of pipList) {
            licenses.push({
                name: pkg.name,
                version: pkg.version,
                license: 'See pip show ' + pkg.name,
                homepage: '',
                licenseText: ''
            });
        }
    } catch (e) {
        // Fallback: try pip-licenses if available
        try {
            const output = execSync('pip-licenses --format=json 2>/dev/null', {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            const pipLicenses = JSON.parse(output);
            for (const pkg of pipLicenses) {
                licenses.push({
                    name: pkg.Name,
                    version: pkg.Version,
                    license: pkg.License,
                    homepage: pkg.URL || '',
                    licenseText: ''
                });
            }
        } catch (e2) {
            console.log('  Warning: Could not collect Python licenses (pip-licenses not installed)');
        }
    }
    
    console.log(`  Found ${licenses.length} Python packages`);
    return licenses;
}

function collectVcpkgLicenses() {
    console.log('Collecting vcpkg licenses...');
    const licenses = new Map(); // Use Map to dedupe by normalized name
    
    const vcpkgInstalledDir = path.join(PROJECT_ROOT, 'build', 'vcpkg', 'installed');
    if (!fs.existsSync(vcpkgInstalledDir)) {
        console.log('  Warning: vcpkg installed directory not found');
        return [];
    }
    
    // Find triplet directory
    const triplets = fs.readdirSync(vcpkgInstalledDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('vcpkg'))
        .map(d => d.name);
    
    for (const triplet of triplets) {
        const shareDir = path.join(vcpkgInstalledDir, triplet, 'share');
        if (!fs.existsSync(shareDir)) continue;
        
        const packages = fs.readdirSync(shareDir, { withFileTypes: true });
        for (const pkg of packages) {
            if (!pkg.isDirectory()) continue;
            
            // Read copyright file
            const copyrightFile = path.join(shareDir, pkg.name, 'copyright');
            let licenseText = '';
            let licenseType = 'Unknown';
            
            if (fs.existsSync(copyrightFile)) {
                try {
                    licenseText = fs.readFileSync(copyrightFile, 'utf8');
                    licenseType = detectLicenseType(licenseText);
                } catch (e) {}
            }
            
            // Try to get version from vcpkg.json
            let version = '';
            const vcpkgJson = readJsonSafe(path.join(shareDir, pkg.name, 'vcpkg.json'));
            if (vcpkgJson?.version) {
                version = vcpkgJson.version;
            } else if (vcpkgJson?.['version-semver']) {
                version = vcpkgJson['version-semver'];
            } else if (vcpkgJson?.['version-string']) {
                version = vcpkgJson['version-string'];
            }
            
            // Normalize name (replace _ with - for deduplication)
            const normalizedName = pkg.name.replace(/_/g, '-');
            
            // Only add if we don't have this package yet, or if this version has more info
            const existing = licenses.get(normalizedName);
            if (!existing || (licenseText && !existing.licenseText)) {
                licenses.set(normalizedName, {
                    name: pkg.name,
                    version: version,
                    license: licenseType,
                    homepage: vcpkgJson?.homepage || '',
                    licenseText: licenseText
                });
            }
        }
    }
    
    console.log(`  Found ${licenses.size} vcpkg packages`);
    return Array.from(licenses.values());
}

function detectLicenseType(licenseText) {
    const lowerText = licenseText.toLowerCase();
    
    // Check Boost first since it also contains "Permission is hereby granted"
    if (licenseText.includes('Boost Software License')) {
        return 'BSL-1.0';
    } else if (licenseText.includes('MIT License') || 
               (licenseText.includes('Permission is hereby granted') && !licenseText.includes('Boost'))) {
        return 'MIT';
    } else if (licenseText.includes('Apache License') || lowerText.includes('apache license')) {
        return 'Apache-2.0';
    } else if (licenseText.includes('BSD 2-Clause') || licenseText.includes('Simplified BSD')) {
        return 'BSD-2-Clause';
    } else if (licenseText.includes('BSD 3-Clause') || licenseText.includes('BSD License')) {
        return 'BSD-3-Clause';
    } else if (lowerText.includes('bsd')) {
        return 'BSD';
    } else if (licenseText.includes('GNU LESSER GENERAL PUBLIC') || licenseText.includes('LGPL')) {
        return 'LGPL';
    } else if (licenseText.includes('GNU GENERAL PUBLIC') || licenseText.includes('GPL')) {
        return 'GPL';
    } else if (licenseText.includes('zlib License') || licenseText.includes('zlib/libpng') || 
               (lowerText.includes("provided 'as-is'") && lowerText.includes('freely'))) {
        return 'Zlib';
    } else if (lowerText.includes('public domain') || lowerText.includes('unlicense')) {
        return 'Public Domain';
    } else if (lowerText.includes('isc license')) {
        return 'ISC';
    } else if (lowerText.includes('mozilla public license')) {
        return 'MPL';
    } else if (lowerText.includes('creative commons')) {
        return 'CC';
    } else if (lowerText.includes('openssl')) {
        return 'OpenSSL';
    }
    return 'Unknown';
}

function collectJavaLicenses() {
    console.log('Collecting Java/Maven licenses...');
    const licenses = [];
    
    const opensourceTxt = path.join(PROJECT_ROOT, 'packages', 'tika', 'lib', 'tika', 'opensource.txt');
    if (fs.existsSync(opensourceTxt)) {
        try {
            const content = fs.readFileSync(opensourceTxt, 'utf8');
            licenses.push({
                name: 'Apache Tika and dependencies',
                version: '',
                license: 'Various (see below)',
                homepage: 'https://tika.apache.org/',
                licenseText: content
            });
        } catch (e) {}
    }
    
    console.log(`  Found ${licenses.length} Java license files`);
    return licenses;
}

function collectProjectLicenses() {
    console.log('Collecting project licenses...');
    const licenses = [];
    
    // Main project license
    const mainLicense = path.join(PROJECT_ROOT, 'LICENSE');
    if (fs.existsSync(mainLicense)) {
        licenses.push({
            name: 'Aparavi Engine',
            version: readJsonSafe(path.join(PROJECT_ROOT, 'package.json'))?.version || '',
            license: 'MIT',
            homepage: 'https://github.com/aparavi/aparavi-engine',
            licenseText: fs.readFileSync(mainLicense, 'utf8')
        });
    }
    
    // Sub-package licenses
    const packageDirs = [
        ...findFiles(path.join(PROJECT_ROOT, 'packages'), 'package.json'),
        ...findFiles(path.join(PROJECT_ROOT, 'apps'), 'package.json'),
        path.join(PROJECT_ROOT, 'nodes', 'package.json'),
    ];
    
    for (const pkgJsonPath of packageDirs) {
        const pkgDir = path.dirname(pkgJsonPath);
        const pkgJson = readJsonSafe(pkgJsonPath);
        if (!pkgJson || !pkgJson.name) continue;
        
        const licenseFile = findLicenseFile(pkgDir);
        let licenseText = '';
        if (licenseFile) {
            try {
                licenseText = fs.readFileSync(licenseFile, 'utf8');
            } catch (e) {}
        }
        
        // Skip if same license as main project
        if (pkgJson.license === 'MIT' && !licenseText) continue;
        
        licenses.push({
            name: pkgJson.name,
            version: pkgJson.version || '',
            license: pkgJson.license || 'unknown',
            homepage: pkgJson.homepage || '',
            licenseText: licenseText
        });
    }
    
    console.log(`  Found ${licenses.length} project packages`);
    return licenses;
}

// ============================================================================
// Standard License Texts
// ============================================================================

const STANDARD_LICENSES = {
    'MIT': `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,

    'ISC': `ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,

    'Apache-2.0': `Apache License, Version 2.0

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`,

    'BSD-2-Clause': `BSD 2-Clause "Simplified" License

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.`,

    'BSD-3-Clause': `BSD 3-Clause "New" or "Revised" License

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.`,

    'BSL-1.0': `Boost Software License - Version 1.0

Permission is hereby granted, free of charge, to any person or organization
obtaining a copy of the software and accompanying documentation covered by
this license (the "Software") to use, reproduce, display, distribute,
execute, and transmit the Software, and to prepare derivative works of the
Software, and to permit third-parties to whom the Software is furnished to
do so, all subject to the following:

The copyright notices in the Software and this entire statement, including
the above license grant, this restriction and the following disclaimer,
must be included in all copies of the Software, in whole or in part, and
all derivative works of the Software, unless such copies or derivative
works are solely in the form of machine-executable object code generated by
a source language processor.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT.`,

    'Zlib': `zlib License

This software is provided 'as-is', without any express or implied warranty.
In no event will the authors be held liable for any damages arising from
the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.`,

    'CC0-1.0': `Creative Commons Zero v1.0 Universal

The person who associated a work with this deed has dedicated the work to
the public domain by waiving all of his or her rights to the work worldwide
under copyright law, including all related and neighboring rights, to the
extent allowed by law.

You can copy, modify, distribute and perform the work, even for commercial
purposes, all without asking permission.`,

    '0BSD': `Zero-Clause BSD License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE.`,

    'Unlicense': `The Unlicense

This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or distribute
this software, either in source code form or as a compiled binary, for any
purpose, commercial or non-commercial, and by any means.`
};

// ============================================================================
// Output Generation
// ============================================================================

function slugify(text) {
    return text.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function hashLicenseText(text) {
    if (!text || text.trim().length === 0) return null;
    const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
    let hash = 0;
    for (let i = 0; i < Math.min(normalized.length, 500); i++) {
        hash = ((hash << 5) - hash) + normalized.charCodeAt(i);
        hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
}

function normalizeLicenseType(license) {
    if (!license) return 'Unknown';
    
    // Normalize common variations
    const normalized = license.trim();
    const upper = normalized.toUpperCase();
    
    // Map common variations to canonical names
    const mappings = {
        'MIT': 'MIT',
        'ISC': 'ISC',
        'BSD': 'BSD',
        'BSD-2-CLAUSE': 'BSD-2-Clause',
        'BSD-3-CLAUSE': 'BSD-3-Clause',
        'APACHE-2.0': 'Apache-2.0',
        'APACHE 2.0': 'Apache-2.0',
        'APACHE LICENSE 2.0': 'Apache-2.0',
        'BSL-1.0': 'BSL-1.0',
        'BOOST SOFTWARE LICENSE': 'BSL-1.0',
        'ZLIB': 'Zlib',
        'CC0-1.0': 'CC0-1.0',
        'CC0': 'CC0-1.0',
        '0BSD': '0BSD',
        'UNLICENSE': 'Unlicense',
        'LGPL': 'LGPL',
        'GPL': 'GPL',
        'MPL': 'MPL',
        'UNKNOWN': 'Unknown'
    };
    
    return mappings[upper] || normalized;
}

function generateLicenseFile(allLicenses) {
    const lines = [];
    
    // Build a map of license type -> packages and custom text
    const licenseGroups = new Map(); // licenseType -> { packages: [], customTexts: Map<hash, text> }
    
    for (const pkg of allLicenses) {
        const licenseType = normalizeLicenseType(pkg.license);
        pkg._normalizedLicense = licenseType; // Store for later use
        
        if (!licenseGroups.has(licenseType)) {
            licenseGroups.set(licenseType, {
                packages: [],
                customTexts: new Map()
            });
        }
        
        const group = licenseGroups.get(licenseType);
        group.packages.push(pkg);
        
        // If this package has custom license text, track it
        if (pkg.licenseText && pkg.licenseText.trim()) {
            const hash = hashLicenseText(pkg.licenseText);
            if (!group.customTexts.has(hash)) {
                group.customTexts.set(hash, {
                    text: pkg.licenseText.trim(),
                    packages: []
                });
            }
            group.customTexts.get(hash).packages.push(pkg.name);
            pkg._customTextHash = hash;
        }
    }
    
    // Header
    lines.push('# Third Party Licenses');
    lines.push('');
    lines.push(`> Generated: ${new Date().toISOString().split('T')[0]}`);
    lines.push('');
    lines.push('This document contains license information for all third-party dependencies used by Aparavi Engine.');
    lines.push('');
    
    // Summary stats
    const categories = { PROJECT: [], NPM: [], PYTHON: [], VCPKG: [], JAVA: [] };
    for (const license of allLicenses) {
        if (license.category) categories[license.category].push(license);
    }
    
    lines.push('## Summary');
    lines.push('');
    lines.push('| Category | Count |');
    lines.push('|----------|-------|');
    for (const [cat, pkgs] of Object.entries(categories)) {
        if (pkgs.length > 0) {
            lines.push(`| ${cat} | ${pkgs.length} |`);
        }
    }
    lines.push(`| **Total** | **${allLicenses.length}** |`);
    lines.push('');
    
    // License type summary with links
    lines.push('## License Types');
    lines.push('');
    lines.push('| License | Count |');
    lines.push('|---------|-------|');
    
    const sortedLicenseTypes = [...licenseGroups.entries()]
        .sort((a, b) => b[1].packages.length - a[1].packages.length);
    
    for (const [type, group] of sortedLicenseTypes) {
        const anchor = slugify(type);
        lines.push(`| [${type}](#${anchor}) | ${group.packages.length} |`);
    }
    lines.push('');
    
    // Main package table
    lines.push('## All Packages');
    lines.push('');
    lines.push('| Package | Version | License |');
    lines.push('|---------|---------|---------|');
    
    const sortedPackages = [...allLicenses].sort((a, b) => a.name.localeCompare(b.name));
    
    for (const pkg of sortedPackages) {
        const version = pkg.version || '-';
        const licenseType = pkg._normalizedLicense || 'Unknown';
        const anchor = slugify(licenseType);
        const licenseLink = `[${licenseType}](#${anchor})`;
        
        lines.push(`| ${pkg.name} | ${version} | ${licenseLink} |`);
    }
    lines.push('');
    
    // License texts section
    lines.push('---');
    lines.push('');
    lines.push('## License Texts');
    lines.push('');
    
    // Output each license type section
    for (const [licenseType, group] of sortedLicenseTypes) {
        const anchor = slugify(licenseType);
        lines.push(`<a id="${anchor}"></a>`);
        lines.push('');
        lines.push(`### ${licenseType}`);
        lines.push('');
        lines.push(`**${group.packages.length} package(s):** ${group.packages.slice(0, 10).map(p => p.name).join(', ')}${group.packages.length > 10 ? '...' : ''}`);
        lines.push('');
        
        // Count packages without custom text
        const packagesWithCustomText = new Set();
        for (const [hash, info] of group.customTexts) {
            for (const pkgName of info.packages) {
                packagesWithCustomText.add(pkgName);
            }
        }
        const packagesWithoutCustomText = group.packages.filter(p => !packagesWithCustomText.has(p.name));
        
        // Always show standard license text first if available
        if (STANDARD_LICENSES[licenseType]) {
            if (packagesWithoutCustomText.length > 0) {
                lines.push(`**Standard ${licenseType} License** (${packagesWithoutCustomText.length} packages):`);
                lines.push('');
            }
            lines.push('```');
            lines.push(STANDARD_LICENSES[licenseType]);
            lines.push('```');
            lines.push('');
            
            // Then show any custom variants in collapsed sections
            if (group.customTexts.size > 0) {
                lines.push('**Custom license variants:**');
                lines.push('');
                for (const [hash, info] of group.customTexts) {
                    lines.push(`<details>`);
                    lines.push(`<summary>${info.packages.slice(0, 3).join(', ')}${info.packages.length > 3 ? ` (+${info.packages.length - 3} more)` : ''}</summary>`);
                    lines.push('');
                    lines.push('```');
                    lines.push(info.text);
                    lines.push('```');
                    lines.push('</details>');
                    lines.push('');
                }
            }
        }
        // No standard license - show custom texts or message
        else if (group.customTexts.size > 0) {
            for (const [hash, info] of group.customTexts) {
                if (group.customTexts.size > 1) {
                    lines.push(`<details>`);
                    lines.push(`<summary>${info.packages.slice(0, 3).join(', ')}${info.packages.length > 3 ? ` (+${info.packages.length - 3} more)` : ''}</summary>`);
                    lines.push('');
                }
                lines.push('```');
                lines.push(info.text);
                lines.push('```');
                if (group.customTexts.size > 1) {
                    lines.push('</details>');
                }
                lines.push('');
            }
        }
        // No license text available at all
        else {
            lines.push('*License text not available. Please refer to the individual package documentation.*');
            lines.push('');
        }
    }
    
    return lines.join('\n');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    console.log('=== License Aggregation ===\n');
    
    ensureDir(DIST_DIR);
    
    // Collect all licenses
    const projectLicenses = collectProjectLicenses().map(l => ({ ...l, category: 'PROJECT' }));
    const npmLicenses = collectNpmLicenses().map(l => ({ ...l, category: 'NPM' }));
    const pythonLicenses = collectPythonLicenses().map(l => ({ ...l, category: 'PYTHON' }));
    const vcpkgLicenses = collectVcpkgLicenses().map(l => ({ ...l, category: 'VCPKG' }));
    const javaLicenses = collectJavaLicenses().map(l => ({ ...l, category: 'JAVA' }));
    
    const allLicenses = [
        ...projectLicenses,
        ...npmLicenses,
        ...pythonLicenses,
        ...vcpkgLicenses,
        ...javaLicenses
    ];
    
    console.log(`\nTotal: ${allLicenses.length} packages\n`);
    
    // Generate output
    const output = generateLicenseFile(allLicenses);
    fs.writeFileSync(OUTPUT_FILE, output);
    
    console.log(`[OK] License file written to: ${OUTPUT_FILE}`);
    console.log(`  Size: ${(output.length / 1024).toFixed(1)} KB`);
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});


import fs from 'fs';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = __dirname;
const MANIFEST_URL = 'http://localhost:9004/assets/assets-list.json';
const BASE_URL = MANIFEST_URL.substring(0, MANIFEST_URL.lastIndexOf('/'));
const CONCURRENCY = 6;
const MAX_RETRIES = 3;
const CACHE_FILE = path.resolve(ROOT_DIR, 'assets', '.assets-version');

export default function earthsdkAssets() {
    let outDir = 'dist';
    return {
        name: 'earthsdk-assets',
        configResolved(config) {
            outDir = config.build.outDir;
        },
        async configureServer(server) {
            await downloadAssets();
            // dev 模式下映射 /js/ -> node_modules 包目录，避免拷贝
            server.middlewares.use('/js', (req, res, next) => {
                const filePath = path.join(ROOT_DIR, req.url);
                if (fs.existsSync(filePath)) {
                    const ext = path.extname(filePath).slice(1);
                    const mimeTypes = { js: 'application/javascript', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', glb: 'model/gltf-binary' };
                    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
                    fs.createReadStream(filePath).pipe(res);
                } else {
                    next();
                }
            });
        },
        async closeBundle() {
            await downloadAssets();
            copyToDest(outDir);
        }
    };
}
function copyToDest(outDir) {
    const dest = path.join(outDir, 'js');
    fs.mkdirSync(dest, { recursive: true });
    const assetsSrc = path.join(ROOT_DIR, 'assets');
    if (fs.existsSync(assetsSrc)) {
        fs.cpSync(assetsSrc, path.join(dest, 'assets'), { recursive: true });
    }
    const sdkSrc = path.join(ROOT_DIR, 'earthsdk3-assets.js');
    if (fs.existsSync(sdkSrc)) {
        fs.cpSync(sdkSrc, path.join(dest, 'earthsdk3-assets.js'));
    }
    console.log('[earthsdk-assets] 资源已拷贝到:', dest);
}
async function downloadAssets() {
    const outDir = path.resolve(ROOT_DIR, 'assets');
    try {
        const assetsList = await fetchJson(MANIFEST_URL);
        const hash = crypto.createHash('md5').update(JSON.stringify(assetsList)).digest('hex');

        // manifest 没变，跳过
        if (fs.existsSync(CACHE_FILE) && fs.readFileSync(CACHE_FILE, 'utf-8').trim() === hash) {
            console.log('[assets] 资源未变化，跳过下载');
            return;
        }

        // manifest 变了，清空重下
        fs.rmSync(outDir, { recursive: true, force: true });

        const tasks = [];
        collectTasks(assetsList, '', tasks, outDir);
        console.log(`[assets] 共 ${tasks.length} 个文件，开始下载...`);
        await downloadWithConcurrency(tasks, CONCURRENCY);

        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(CACHE_FILE, hash, 'utf-8');
        console.log('[assets] 下载完成');
    } catch (err) {
        console.error('[assets] 下载失败:', err.message);
        throw err;
    }
}
function getProtocol(url) {
    if (url.startsWith('https://')) return https;
    if (url.startsWith('http://')) return http;
    throw new Error('不支持的协议: ' + url);
}
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        getProtocol(url).get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}: ${url}`));
                return;
            }
            let data = '';
            response.on('data', (chunk) => (data += chunk));
            response.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    reject(new Error(`JSON 解析失败: ${url}`));
                }
            });
            response.on('error', reject);
        }).on('error', reject);
    });
}

function collectTasks(node, currentPath, tasks, outDir) {
    for (const key in node) {
        if (!Object.hasOwn(node, key)) continue;
        const value = node[key];
        const nextPath = path.join(currentPath, key);
        if (typeof value === 'string') {
            const filePath = path.join(currentPath, value).replaceAll('\\', '/');
            pushTask(filePath, tasks, outDir);
        } else if (Array.isArray(value)) {
            for (const fileName of value) {
                const filePath = path.join(nextPath, fileName).replaceAll('\\', '/');
                pushTask(filePath, tasks, outDir);
            }
        } else if (value && typeof value === 'object') {
            collectTasks(value, nextPath, tasks, outDir);
        }
    }
}
function pushTask(filePath, tasks, outDir) {
    const outputPath = path.join(outDir, filePath);
    tasks.push({
        url: `${BASE_URL}/${filePath}`,
        outputPath,
    });
}
async function downloadWithConcurrency(tasks, limit) {
    const queue = [...tasks];
    const workers = new Array(limit).fill(null).map(async () => {
        while (queue.length) {
            const task = queue.shift();
            if (!task) break;
            await downloadWithRetry(task.url, task.outputPath, MAX_RETRIES);
        }
    });
    await Promise.all(workers);
}
async function downloadWithRetry(url, outputPath, retries) {
    for (let i = 0; i < retries; i++) {
        try {
            await downloadFile(url, outputPath);
            return;
        } catch (err) {
            if (i === retries - 1) {
                console.error(`[assets] 下载失败(已重试${retries}次): ${url}`);
                throw err;
            }
            console.warn(`[assets] 重试(${i + 1}/${retries}): ${url}`);
        }
    }
}
function downloadFile(url, outputPath) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const tempPath = outputPath + '.download';
        const file = fs.createWriteStream(tempPath);
        getProtocol(url).get(url, (response) => {
            if (response.statusCode !== 200) {
                file.close();
                try { fs.unlinkSync(tempPath); } catch { }
                reject(new Error(`HTTP ${response.statusCode}: ${url}`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(() => {
                    fs.renameSync(tempPath, outputPath);
                    resolve();
                });
            });
            file.on('error', (err) => {
                try { fs.unlinkSync(tempPath); } catch { }
                reject(err);
            });
            response.on('error', (err) => {
                try { fs.unlinkSync(tempPath); } catch { }
                reject(err);
            });
        }).on('error', (err) => {
            try { fs.unlinkSync(tempPath); } catch { }
            reject(err);
        });
    });
}
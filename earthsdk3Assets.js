import fs from 'fs';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = __dirname;

const MANIFEST_URL = "https://114.242.26.126:1000/EarthSDK/earthsdk3-assets/assets-list.json";

const BASE_URL = MANIFEST_URL.substring(0, MANIFEST_URL.lastIndexOf('/'));

const CONCURRENCY = 6;
const MAX_RETRIES = 3;

const ASSETS_DIR = path.resolve(ROOT_DIR, 'assets');
const CACHE_FILE = path.resolve(ASSETS_DIR, '.assets-version');
const MANIFEST_CACHE_FILE = path.resolve(ASSETS_DIR, '.assets-manifest.json');
const IGNORE_FILES = new Set(['.assets-version', '.assets-manifest.json']);

let hasDownloaded = false;

export default function earthsdkAssets() {
    let outDir = 'dist';
    return {
        name: 'earthsdk-assets',
        // 在index.html中注入earthsdk3-assets.js
        transformIndexHtml() {
            return [
                {
                    tag: 'script',
                    attrs: {
                        src: '/js/earthsdk3-assets.js'
                    },
                    injectTo: /**@type {"head"} */ ('head')
                }
            ];
        },
        configResolved(config) {
            outDir = config.build.outDir;
        },
        async configureServer(server) {
            await ensureAssets();
            // dev 模式资源映射
            server.middlewares.use(
                '/js',
                (req, res, next) => {
                    try {
                        const filePath = path.resolve(ROOT_DIR, '.' + decodeURIComponent(req.url));
                        if (!fs.existsSync(filePath)) {
                            next();
                            return;
                        }
                        const ext = path.extname(filePath)
                            .slice(1)
                            .toLowerCase();
                        const mimeTypes = {
                            js: 'application/javascript',
                            json: 'application/json',
                            png: 'image/png',
                            jpg: 'image/jpeg',
                            jpeg: 'image/jpeg',
                            webp: 'image/webp',
                            glb: 'model/gltf-binary',
                            bin: 'application/octet-stream'
                        };
                        res.setHeader(
                            'Content-Type',
                            mimeTypes[ext] ||
                            'application/octet-stream'
                        );
                        fs.createReadStream(filePath).pipe(res);
                    } catch (err) {
                        next(err);
                    }
                }
            );
        },
        async closeBundle() {
            await ensureAssets();
            copyToDest(outDir);
        }
    };
}
async function ensureAssets() {
    if (hasDownloaded) {
        return;
    }
    hasDownloaded = true;
    await downloadAssets();
}

function stableStringify(obj) {
    if (Array.isArray(obj)) {
        return `[${obj.map(stableStringify).join(',')}]`;
    }
    if (obj && typeof obj === 'object') {
        return `{${Object.keys(obj).sort().map(
            k =>
                `"${k}":${stableStringify(obj[k])}`
        ).join(',')}}`;
    }
    return JSON.stringify(obj);
}

function copyToDest(outDir) {
    const dest = path.join(outDir, 'js');
    fs.mkdirSync(dest, { recursive: true });
    // assets
    if (fs.existsSync(ASSETS_DIR)) {
        fs.cpSync(ASSETS_DIR, path.join(dest, 'assets'), {
            recursive: true,
            filter(src) {
                const baseName = path.basename(src);
                // 忽略缓存文件
                if (IGNORE_FILES.has(baseName)) {
                    return false;
                }
                // 忽略临时文件
                if (baseName.endsWith('.download') || baseName.endsWith('.tmp')) {
                    return false;
                }
                return true;
            }
        }
        );
    }
    // loader js
    const sdkSrc = path.join(ROOT_DIR, 'earthsdk3-assets.js');
    if (fs.existsSync(sdkSrc)) {
        fs.cpSync(sdkSrc, path.join(dest, 'earthsdk3-assets.js'));
    }
    console.log('[earthsdk-assets] 资源已拷贝到:', dest);
}

async function downloadAssets() {
    try {
        const newAssetsList = await fetchJson(MANIFEST_URL);
        const newHash = crypto.createHash('md5').update(
            stableStringify(newAssetsList)
        ).digest('hex');
        // 读取旧的 manifest
        let oldAssetsList = null;
        if (fs.existsSync(MANIFEST_CACHE_FILE)) {
            try {
                oldAssetsList = JSON.parse(fs.readFileSync(MANIFEST_CACHE_FILE, 'utf-8'));
            } catch {
                oldAssetsList = null;
            }
        }
        // manifest 未变化
        if (fs.existsSync(CACHE_FILE) && fs.readFileSync(CACHE_FILE, 'utf-8').trim() === newHash) {
            console.log('[assets] 资源未变化，跳过下载');
            return;
        }
        // 收集需要下载和删除的文件
        const downloadTasks = [];
        const deletePaths = [];
        if (oldAssetsList && fs.existsSync(ASSETS_DIR)) {
            // 增量更新：对比新旧 manifest
            const newFiles = new Set();
            const oldFiles = new Set();
            collectFilePaths(newAssetsList, '', newFiles);
            collectFilePaths(oldAssetsList, '', oldFiles);
            // 找出需要删除的文件（旧有但新 manifest 中不存在的）
            for (const filePath of oldFiles) {
                if (!newFiles.has(filePath)) {
                    deletePaths.push(filePath);
                }
            }
            // 找出需要下载的文件（新增或 md5 变化的）
            collectDownloadTasks(newAssetsList, oldAssetsList, '', downloadTasks, ASSETS_DIR);
        } else {
            // 首次下载：全部下载
            collectTasks(newAssetsList, '', downloadTasks, ASSETS_DIR);
        }
        // 删除不需要的文件
        if (deletePaths.length > 0) {
            console.log(`[assets] 删除 ${deletePaths.length} 个文件...`);
            for (const filePath of deletePaths) {
                const fullPath = path.join(ASSETS_DIR, filePath);
                try {
                    fs.rmSync(fullPath, { force: true });
                } catch (err) {
                    console.warn(`[assets] 删除文件失败: ${fullPath}`);
                }
            }
        }
        // 下载需要更新的文件
        if (downloadTasks.length > 0) {
            console.log(`[assets] 共 ${downloadTasks.length} 个文件需要下载...`);
            await downloadWithConcurrency(downloadTasks, CONCURRENCY);
        } else {
            console.log('[assets] 无需下载新文件');
        }
        // 更新缓存
        fs.mkdirSync(ASSETS_DIR, { recursive: true });
        fs.writeFileSync(CACHE_FILE, newHash, 'utf-8');
        fs.writeFileSync(MANIFEST_CACHE_FILE, JSON.stringify(newAssetsList, null, 2), 'utf-8');
        console.log('[assets] 下载完成');
    } catch (err) {
        console.error('[assets] 下载失败:', err.message);
        throw err;
    }
}
const agent = new https.Agent({
    rejectUnauthorized: false
});
function getProtocol(url) {
    if (url.startsWith('https://')) {
        return https;
    }
    if (url.startsWith('http://')) {
        return http;
    }
    throw new Error('不支持的协议: ' + url);
}

function fetchJson(url) {
    return new Promise(
        (resolve, reject) => {
            const request = getProtocol(url).get(url, { agent }, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}: ${url}`));
                    return;
                }
                let data = '';
                response.on('data', chunk => {
                    data += chunk;
                });
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        reject(new Error(`JSON 解析失败: ${url}`));
                    }
                });
                response.on('error', reject);
            });
            request.setTimeout(15000, () => {
                request.destroy(new Error('请求超时'));
            });

            request.on('error', reject);
        }
    );
}

function collectTasks(node, currentPath, tasks, outDir) {
    for (const key in node) {
        if (!Object.hasOwn(node, key)) {
            continue;
        }
        const value = node[key];
        const nextPath = path.join(currentPath, key);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (typeof value.size === 'number' && typeof value.md5 === 'string') {
                // 是文件节点，文件名是 key
                const filePath = nextPath.replaceAll('\\', '/');
                pushTask(filePath, tasks, outDir);
            } else {
                // 是目录节点，继续递归
                collectTasks(value, nextPath, tasks, outDir);
            }
        } else if (Array.isArray(value)) {
            for (const fileName of value) {
                const filePath = path.join(nextPath, fileName).replaceAll('\\', '/');
                pushTask(filePath, tasks, outDir);
            }
        }
    }
}

function collectFilePaths(node, currentPath, fileSet) {
    for (const key in node) {
        if (!Object.hasOwn(node, key)) {
            continue;
        }
        const value = node[key];
        const nextPath = path.join(currentPath, key);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (typeof value.size === 'number' && typeof value.md5 === 'string') {
                fileSet.add(nextPath.replaceAll('\\', '/'));
            } else {
                collectFilePaths(value, nextPath, fileSet);
            }
        } else if (Array.isArray(value)) {
            for (const fileName of value) {
                fileSet.add(path.join(nextPath, fileName).replaceAll('\\', '/'));
            }
        }
    }
}

function collectDownloadTasks(newNode, oldNode, currentPath, tasks, outDir) {
    for (const key in newNode) {
        if (!Object.hasOwn(newNode, key)) {
            continue;
        }
        const newValue = newNode[key];
        const oldValue = oldNode && Object.hasOwn(oldNode, key) ? oldNode[key] : null;
        const nextPath = path.join(currentPath, key);
        if (newValue && typeof newValue === 'object' && !Array.isArray(newValue)) {
            if (typeof newValue.size === 'number' && typeof newValue.md5 === 'string') {
                // 是文件节点
                const filePath = nextPath.replaceAll('\\', '/');
                // 检查是否需要下载：不存在于旧列表或 size 变化或 md5 变化
                // 先比较 size（更快），只有 size 相同时才比较 md5
                if (!oldValue || typeof oldValue !== 'object' || oldValue.size !== newValue.size || oldValue.md5 !== newValue.md5) {
                    pushTask(filePath, tasks, outDir);
                }
            } else {
                // 继续递归
                collectDownloadTasks(newValue, oldValue, nextPath, tasks, outDir);
            }
        } else if (Array.isArray(newValue)) {
            for (const fileName of newValue) {
                const filePath = path.join(nextPath, fileName).replaceAll('\\', '/');
                const oldArray = Array.isArray(oldValue) ? oldValue : [];
                if (!oldArray.includes(fileName)) {
                    pushTask(filePath, tasks, outDir);
                }
            }
        }
    }
}

function pushTask(filePath, tasks, outDir) {
    const outputPath = path.join(outDir, filePath);
    tasks.push({
        url: `${BASE_URL}/${filePath}`,
        outputPath
    });
}

async function downloadWithConcurrency(tasks, limit) {
    const queue = [...tasks];
    const workers = new Array(limit).fill(null).map(async () => {
        while (queue.length) {
            const task = queue.shift();
            if (!task) {
                break;
            }
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
        fs.mkdirSync(path.dirname(outputPath), {
            recursive: true
        });
        const tempPath = outputPath + '.download';
        const file = fs.createWriteStream(tempPath);
        const request = getProtocol(url).get(url, { agent }, (response) => {
            if (response.statusCode !== 200) {
                file.close();
                try {
                    fs.unlinkSync(tempPath);
                } catch { }
                reject(new Error(`HTTP ${response.statusCode}: ${url}`));
                return;
            }
            response.pipe(file);

            file.on('finish', () => {

                file.close(() => {
                    // Windows rename 覆盖问题
                    fs.rmSync(outputPath, { force: true });
                    fs.renameSync(tempPath, outputPath);
                    resolve();
                });
            });

            file.on('error', (err) => {
                try {
                    fs.unlinkSync(tempPath);
                } catch { }
                reject(err);
            });

            response.on('error', (err) => {
                try {
                    fs.unlinkSync(tempPath);
                } catch { }

                reject(err);
            });
        });

        request.setTimeout(15000, () => {
            request.destroy(new Error('请求超时'));
        });

        request.on('error', (err) => {
            try {
                fs.unlinkSync(tempPath);
            } catch { }
            reject(err);
        });
    });
}
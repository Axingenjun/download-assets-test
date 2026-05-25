import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
const url = "http://localhost:9004/assets/assets-list.json";

const baseUrl = url.substring(0, url.lastIndexOf('/'));

const packageJson =
    JSON.parse(
        fs.readFileSync(
            "../package.json",
            "utf-8"
        )
    );
const currentVersion = packageJson.version;

let oldVersion = "";
const versionFile = './version.txt'
if (fs.existsSync(versionFile)) {
    oldVersion = fs.readFileSync(versionFile, 'utf-8');
}
if (oldVersion !== currentVersion) {
    fs.rmSync('../assets', {
        recursive: true,
        force: true,
    })
}
getProtecol(url).get(url, (response) => {
    let data = ""
    response.on("end", async () => {
        const assetsList = JSON.parse(data);
        await traverse(assetsList);
        fs.writeFileSync(versionFile, currentVersion, 'utf-8');
        console.log("下载完成：", currentVersion)
    });
    response.on('data', (chunk) => {
        data += chunk;
    })
})

function getProtecol(url) {
    if (url.startsWith("http://")) {
        return http;
    } else if (url.startsWith("https://")) {
        return https;
    } else {
        throw new Error("不支持的协议");
    }
}
const tasks = [];
async function traverse(node, currentPath = "") {
    for (const key in node) {
        if (Object.prototype.hasOwnProperty.call(node, key)) {
            const value = node[key];
            const nextPath = path.join(currentPath, key);
            if (typeof value === "string") {
                const fileRelativePath = path.join(currentPath, value).replaceAll("\\", "/");;
                const downloadUrl = `${baseUrl}/${fileRelativePath}`;
                const outputPath = path.join('../assets', fileRelativePath);
                if (needDownload(outputPath)) {
                    tasks.push({
                        url: downloadUrl,
                        outputPath
                    });
                }
            } else if (Array.isArray(value)) {
                for (const fileName of value) {
                    const fileRelativePath = path.join(nextPath, fileName).replaceAll("\\", "/");;
                    const downloadUrl = `${baseUrl}/${fileRelativePath}`;
                    const outputPath = path.join('../assets', fileRelativePath);
                    if (needDownload(outputPath)) {
                        tasks.push({
                            url: downloadUrl,
                            outputPath
                        });
                    }
                }
            } else if (value && typeof value === "object") {
                await traverse(value, nextPath);
                await Promise.all(
                    tasks.map(task => {
                        return downloadFile(task.url, task.outputPath);
                    })
                )
            }
        }
    }
}

function downloadFile(url, outputPath) {
    return new Promise((reslove, rejects) => {
        fs.mkdirSync(path.dirname(outputPath), {
            recursive: true
        })
        const file = fs.createWriteStream(outputPath);
        getProtecol(url).get(url, (response) => {
            if (response.statusCode !== 200) {
                file.close();
                fs.unlink(outputPath, () => { });
                rejects(new Error(`下载失败：${url}`))
                return;
            }
            response.pipe(file);
            file.on("close", () => {
                reslove();
            })
            response.on('error', (err) => {
                fs.unlink(outputPath, () => { });
                rejects(err);
            })
            file.on('error', (err) => {
                fs.unlink(outputPath, () => { });
                rejects(err);
            })
        }).on("error", rejects);
    })
}

function needDownload(outputPath) {
    return !fs.existsSync(outputPath);
}
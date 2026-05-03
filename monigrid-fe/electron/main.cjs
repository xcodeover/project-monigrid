const path = require("path");
const { app, BrowserWindow, shell } = require("electron");

const isDev = Boolean(process.env.ELECTRON_START_URL);

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1100,
        minHeight: 700,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            // Renderer runs in OS-level sandbox so a compromised page can't
            // touch the filesystem or spawn processes via Electron primitives.
            // The preload only uses contextBridge which is sandbox-compatible.
            sandbox: true,
            webSecurity: true,
        },
    });

    if (isDev) {
        mainWindow.loadURL(process.env.ELECTRON_START_URL);
        mainWindow.webContents.openDevTools({ mode: "detach" });
    } else {
        mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
    }

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: "deny" };
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

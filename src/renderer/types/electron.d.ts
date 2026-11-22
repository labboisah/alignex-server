export {};

declare global {
    interface Window {
        alignex?: {
            openExportFolder?: (folderPath: string) => Promise<{ success: boolean; message?: string }>;
            uninstallLocalData: (password: string) => Promise<{ success: boolean; message?: string }>;
        };
    }
}

import { Notification } from "@/types";
import { versionsSatisfies } from "@/utils/version-utils";
import { modals, notifications as sdkNotifications } from "@pulsesync/addon-sdk";
import { openExternalLink } from "@/utils/common";
import addonConfig from "../../addon.config.mjs";
import { getStorageBoolean, setStorageItem } from "@/utils/storage";
import { warn } from '@/utils/logger'

export async function handleNotifications(notifications: Notification[]) {
    for (const notification of notifications) {
        if (typeof notification?.id !== 'string' || typeof notification.message?.content !== 'string' ||
            (notification.version && !versionsSatisfies(addonConfig.version, notification.version)) ||
            (notification.expires && new Date(notification.expires) < new Date()) ||
            isNotificationHandled(notification)) continue;
        
        const message = notification.message

        if (notification.type === "notification") {
            const icon = typeof message.icon === 'string' ? message.icon : undefined
            const isCoverUrl = icon?.startsWith('http')
            await sdkNotifications.info(message.content, {
                durationMs: message.durationMs,
                icon: icon && !isCoverUrl ? icon as any : undefined,
                coverUrl: isCoverUrl ? icon : undefined,
            }).then(() => saveHandleNotification(notification)).catch(cause => warn('Could not show catalog notification', cause))
            continue
        }
        else {
            (notification.type === "alert" ? modals.alert : modals.confirm)({
                message: message.content,
                title: message.title ?? addonConfig.name,
                confirmLabel: message.buttons?.length ? message.buttons[0].label : undefined,
                cancelLabel: (message.buttons?.length ?? 0) >= 2 && Array.isArray(message.buttons) && message.buttons[1].label ? message.buttons[1].label : undefined
            }).then((confirm) => {
                if (notification.once === false) saveHandleNotification(notification)
                
                if (!message.buttons?.length) return;

                if (confirm && message.buttons[0].href) {
                    openExternalLink(message.buttons[0].href)
                }
                else if (!confirm && message.buttons.length >= 2 && message.buttons[1].href) {
                    openExternalLink(message.buttons[1].href)
                }
            }).catch(cause => warn('Could not show catalog dialog', cause))
        }

        if (notification.once !== false) {
            saveHandleNotification(notification)
        }
    }
}

const getStorageHandleKey = (notification: Notification) => `notification-handled:${notification.id}`

function isNotificationHandled(notification: Notification) {
    return getStorageBoolean(getStorageHandleKey(notification))
}

function saveHandleNotification(notification: Notification) {
    setStorageItem(getStorageHandleKey(notification), true);
}

param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Message
)

# Windows toast через WinRT ToastNotificationManager.
# Запускать ТОЛЬКО через powershell.exe 5.1 — тип Windows.UI.Notifications
# проецируется только в нём, pwsh 7 падает с "Unable to find type".
# Файл обязан быть UTF-8 С BOM, иначе 5.1 читает кириллицу как мусор.
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $template.GetElementsByTagName('text')
$texts.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
$texts.Item(1).AppendChild($template.CreateTextNode($Message)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Agent Harness').Show($toast)


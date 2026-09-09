# Chrome应用商店开发者后台

实测2026-09-09：扩展注入受限，但macOS上可通过Chrome已有的Apple事件接口完成软件包上传与提审。不要把某条工具路径不可用写成「只能人做」。

## 扩展工具的边界

`chrome.google.com/webstore/*`包含devconsole。注入类工具会报`The extensions gallery cannot be scripted`；`chrome.debugger`的attach也被拒，因此基于它的`upload`不可用。`tabs`仍可开页或选择标签。报错后停止重试该路径。

## macOS：准确定位Chrome进程

前提是用户已启用「允许Apple事件中的JavaScript」。未启用或出现登录、通行密钥验证时，由用户处理。

按应用名调用AppleScript可能误连同时运行的headless Chrome，返回0个窗口；这不证明主浏览器窗口丢失。先核对进程命令行，再用ScriptingBridge按PID连接主Chrome。PID、窗口序号和标签序号都须现场查询，不写死。

```js
// osascript -l JavaScript；mainPid为现场核对的主Chrome进程ID
ObjC.import('ScriptingBridge');
var app = $.SBApplication.applicationWithProcessIdentifier(mainPid);
var windows = app.valueForKey('windows');
// 遍历windows、各窗口的tabs，用id与URL核对目标tab
// 读取属性：ObjC.unwrap(tab.valueForKey('URL'))
// 执行页面JS：
ObjC.unwrap(tab.performSelectorWithObject('executeJavascript:', $(source)));
```

JXA直接调用`tab.executeJavascript(...)`本轮报「不是函数」，上述`performSelectorWithObject`实测有效。长JS从UTF-8文件读取，避免拼接到shell命令。

## 上传现有zip

1. 核对商品ID与本地zip版本，点击「上传新的软件包」。
2. 页面出现`input[type=file][accept=".zip,.crx"]`。将本地zip字节以base64传入页面JS，用`Uint8Array`、`File`、`DataTransfer`设置该控件，再派发`change`：

```js
const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
const transfer = new DataTransfer();
transfer.items.add(new File([bytes], filename, {type: 'application/zip'}));
const input = document.querySelector('input[type=file][accept=".zip,.crx"]');
input.files = transfer.files;
input.dispatchEvent(new Event('change', {bubbles: true}));
```

3. 等待上传和服务器处理结束，重新打开文件包页，确认「草稿」版本已更新。本轮183KB扩展包已验证成功；更大文件的传输上限未测试。

上传会使原控件消失，执行脚本返回空值也可能是页面切换所致；以服务器处理结果与重新读取的版本为准。

## 提审与回执

商品详情页的「提请审核」会打开确认框。先读正文及自动发布选项，已有本次发布授权时再确认。过去出现过第二层权限审核提醒，但不保证每次出现；按实际页面处理。

「正在提交」表示仍未取得完成证据，不要重复提交。最终刷新状态页，核对待审版本、审核状态和自动发布设置。后台标签可能被节流，必要时告知用户后切前台。

本轮提交请求约60秒后，原页面显示「内部发布错误」，重新打开状态页却明确显示「待审核」。页面错误不能单独证明提审失败；先核对服务器状态，再决定是否需要恢复操作。

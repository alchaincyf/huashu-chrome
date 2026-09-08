# CloudKit Console：发布前补齐生产schema

实测：2026-09-08，已登录Chrome，Core Data的NSPersistentCloudKitContainer应用。适用于核查/部署已授权发布版本的模型，不是用户数据迁移教程。当前页面与官方文档优先。

## 先分清两个问题

先从项目实现确认确实使用CloudKit以及需要哪些模型。iCloud Drive/键值存储等能力不走本流程；更新说明出现「iCloud」不是schema缺失的证据。Production已具有全部所需模型时，不为复用本流程重新初始化或部署。

上传构建成功不代表iCloud同步可用。开发包通常连接Development，App Store/TestFlight连接Production；生产环境不能像开发环境一样临时创建未知模型。

进入CloudKit Database，核对team、container和environment。Record Types只有Users、Deploy Schema Changes显示0项，可能是开发模型尚未初始化，不能写「无差异，已经就绪」。

本轮从首页进入数据库会回到上次使用的container；必须以当前URL、容器选择器确认目标，不能假设默认就是正在提审的App。

## 从模型生成，别手拼字段

对Core Data应用，使用项目真实模型和有CloudKit entitlement的开发包初始化。检查实际签名包中的container标识和environment，不只看源码.entitlements。不要把Release上传包重新安装当开发环境。

优先走现有开发工具；需要一次性初始化入口时，本轮验证的方法是：

1. 在Debug且显式启动参数生效时，使用独立临时SQLite URL，给NSPersistentCloudKitContainer配置正确container。
2. loadPersistentStores成功后调用`initializeCloudKitSchema(options: [])`。不要在用户的默认生产数据库上插造测试记录来猜字段。
3. 签名开发包安装到已配对且可用的iPhone；运行初始化后，从网页重新读取Record Types、字段、索引。模拟器没登录iCloud时「App没崩」不能代替成功初始化证据。
4. 完成后保留可复现patch/日志，撤掉临时源码入口；不要把初始化副作用带进正式发行包。

本轮系统为业务字段之外自动生成了`CD_entityName`、`CD_moveReceipt`、`*_ckAsset`与索引；这也是不应手工按实体属性猜schema的原因。表名、字段和数量属于具体模型，下一次不可照抄本轮数值。

原生设备命令要先查本机help。本轮`devicectl device process launch ... -- <bundleId> -initializeCloudKitSchema`中，`--`用于分隔启动参数，否则命令本身可能报参数错误。一次带console启动报10004，随后普通launch成功且服务器出现模型；这种回执不能单独证明App崩溃或schema失败。查看进程与服务端状态后再判断，不因一次失败重置设备/权限。

## 部署与读回

页面：Development→Deploy Schema Changes→Changes/Diff View。检查差异对应待发布模型、没有混入其它试验结构，然后在发布授权范围内点Deploy。

本轮成功弹层原文为「Changes Deployed」「The schema is deployed to Production」。点Done关闭弹层，再切Production，实际打开Record Types查看新字段和索引。背景页切换后可能只显示骨架，短暂切前台再读；不要被旧页面数据误导。

部署只复制schema，不复制开发测试记录。生产schema的删字段/改类型受到限制，不能用「先随便部署，错了再删」的试错方式。两设备同账号下的新建/更新/删除同步需要另外验收，不能把部署成功宣称为同步全链路成功。

## 数据库权限的解释边界

Core Data初始化可能生成带`GRANT READ TO "_world"`等角色的schema。角色声明本身不能用来推断用户私有库公开；先确认应用实际使用private还是public database。若应用使用公共库，应另外检查读写权限是否符合产品预期，不能套用私有库结论。

参考：[Apple部署iCloud容器schema](https://developer.apple.com/documentation/cloudkit/deploying-an-icloud-container-s-schema)。

## 留下可复核证据

项目内保存：待审版本/构建标识、模型来源、初始化开发包身份、部署时间、container/environment、差异摘要、Production字段读回与截图、尚未完成的同步测试。不要把账号、用户记录、Cookie、证书私钥写进共享经验。

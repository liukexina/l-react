# l-react

react 17.0.0 源码阅读

## create-react-app

基于npm在全局安装create-react-app
```
npm install -g create-react-app
create-react-app my-app-name
yarn start
```

## Eject 配置
因为我们需要对项目中的依赖进行自定义配置，所以，我们需要暴露出 React 项目的配置文件，执行：
```
yarn eject
```
我们就会得到 React 项目的配置文件config以及一些构建脚本

## 克隆 React 源码
克隆一个指定版本的 React 源码，到src/react目录下，当然这里也可以使用master分支，但是不建议。如果你需要将你自己对代码的修改保存到版本控制中，你最好自己fork一份React官方的repo，到自己的账号。
```
话说 github 是在是太慢了，所以，我fork了一份，到我的github仓库，然后，强制同步到了gitee仓库了。
```

## 开始修改配置
### webpack 中将包链接到源代码
修改/config/webpack.config.js
```js
resolve: {
    alias: {
        'react-native': 'react-native-web',
+        'react': path.resolve(__dirname, '../src/react/packages/react'),
+        'react-dom': path.resolve(__dirname, '../src/react/packages/react-dom'),
+        'shared': path.resolve(__dirname, '../src/react/packages/shared'),
+        'react-reconciler': path.resolve(__dirname, '../src/react/packages/react-reconciler'),
         'react-events': path.resolve(__dirname, '../src/react/packages/events')
    }
}
```
需要注意的一点是：react-events在master分支中已经变更为legacy-events了，不需要在此处添加了。

### 修改环境变量
修改/config/env.js
```js
const stringified = {
  __DEV__: true,
  __PROFILE__: true,
  __UMD__: true,
  'process.env': Object.keys(raw).reduce((env, key) => {
    env[key] = JSON.stringify(raw[key])
    return env
  }, {})
}
```
根目录创建.eslintrc.json文件
```js
{
  "extends": "react-app",
  "globals": {
    "__DEV__": true,
    "__PROFILE__": true,
    "__UMD__": true
  }
}
```

### 忽略 flow 下 type
```js
yarn add @babel/plugin-transform-flow-strip-types -D
```
同时在/config/webpack.config.js中babel-loader的plugins中添加该插件
```js
{
              test: /\.(js|mjs|jsx|ts|tsx)$/,
              include: paths.appSrc,
              loader: require.resolve('babel-loader'),
              options: {
                customize: require.resolve(
                  'babel-preset-react-app/webpack-overrides'
                ),

                plugins: [
+                  require.resolve('@babel/plugin-transform-flow-strip-types'),
                  [
                    require.resolve('babel-plugin-named-asset-import'),
                    {
                      loaderMap: {
                        svg: {
                          ReactComponent:
                            '@svgr/webpack?-svgo,+titleProp,+ref![path]'
                        }
                      }
                    }
                  ]
                ],
                // This is a feature of `babel-loader` for webpack (not Babel itself).
                // It enables caching results in ./node_modules/.cache/babel-loader/
                // directory for faster rebuilds.
                cacheDirectory: true,
                // See #6846 for context on why cacheCompression is disabled
                cacheCompression: false,
                compact: isEnvProduction
              }
            },
```
就是避免这个错误：
```js
Failed to compile.

./src/react/packages/react-dom/src/client/ReactDOM.js
SyntaxError: ./reading_source/src/react/packages/react-dom/src/client/ReactDOM.js: Unexpected token (10:12)

   8 |  */
   9 |
> 10 | import type {ReactNodeList} from 'shared/ReactTypes';
     |             ^
  11 | // TODO: This type is shared between the reconciler and ReactDOM, but will
  12 | // eventually be lifted out to the renderer.
  13 | import type {
```

### 修改react引用方式
报错如下：
```
Failed to compile.

./src/index.js
Attempted import error: 'react' does not contain a default export (imported as 'React').
```
出现上述错误，到源码中查看源码，发现/debug-react-new/src/packages/react/index.js中确实没有默认导出。但是必须保证业务组件中要引入React，因为组件需要用babel-jsx插件进行转换(即使用React.createElement方法)。因此可以添加一个中间模块文件，来适配该问题。
```js
import * as React from 'react';
import * as ReactDOM from 'react-dom';
```
### 解决 event 冲突(master 分支请忽略)
在webpack.config.js中的alias中添加react-events后，需要修改react源码包中相应引用event的部分，具体如下：
```
替换源码中所有的import XXX from 'events/...'为import XXX from 'react-events/...'，其中react-events就是alias中的命名。
```

### 导出 HostConfig

修改文件/src/react/packages/react-reconciler/src/ReactFiberHostConfig.js。注释中说明，这块还需要根据环境去导出HostConfig。
```js
// invariant(false, 'This module must be shimmed by a specific renderer.');
export * from './forks/ReactFiberHostConfig.dom'
```

### 保持 import first，根据编译信息修改
修改文件/src/react/packages/shared/ReactSharedInternals.js。react此时未export内容，直接从ReactSharedInternals拿值
```js
//  import React from 'react';
import ReactSharedInternals from '../react/src/ReactSharedInternals'

//  const ReactSharedInternals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
```

### 关闭 ESlint 对 fbjs 插件的扩展
修改src/react/.eslingrc.js，在module.exports中删去extends: 'fbjs'：
```js
module.exports = {
  // extends: 'fbjs',
  ......
```

### 修改invariant.js
/xxx/debug-react-new/src/react/packages/shared/invariant.js
```js
export default function invariant(condition, format, a, b, c, d, e, f) {

  if (condition) {
    return;
  }
  throw new Error(
    'Internal React error: invariant() is meant to be replaced at compile ' +
      'time. There is no runtime version.',
  );
}
```

## 参考链接
https://zhuanlan.zhihu.com/p/336794903  
https://www.borgor.cn/2019-12-09/f48cc00c.html
## 注意

git提交不了vendor/无法识别目录
* 第一检查根目录配置文件.gitignore
* 第二检查未目录中是否有.git目录
* 第三执行git rm -rf --cached path（你的目录）




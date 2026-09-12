// Run the existing plugin smoke checks without touching installed plugin data.
const {app}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const dir=path.resolve(__dirname,'../dist/plugin-smoke-check',randomUUID());
fs.mkdirSync(dir,{recursive:true});
app.setPath('userData',dir);
app.setPath('sessionData',dir);
require('../smoke-plugins-main.js');

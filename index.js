let log = console.log;
const ipv4 = require('./ipv4.js');
const sudo = require('./sudo.js');
const fs = require('fs');
const pathm = require('path');
const exec = require('child_process').exec;
let pluginInterface;
let localStorage;

const NMCLI_CONNECTION_NAME_PREFIX = 'picogw_conn';

/**
 * Initialize Plugin
 * @param {object} _pluginInterface Plugin interface
 */
function init(_pluginInterface) {
    pluginInterface = _pluginInterface;
    const pi = pluginInterface;
    localStorage = pi.localStorage;
    log = pi.log;
    ipv4.setNetCallbackFunctions(
        function(net, newmac, newip) {
            for (const callbacks of NetCallbacks) {
                if (callbacks.onMacFoundCallback != undefined) {
                    callbacks.onMacFoundCallback(net, newmac, newip);
                }
            }
            // NetCallbacks[plugin_name].onNewIDFoundCallback(newid,newip);
        }
        , function(net, lostmac, lostip) {
            for (const callbacks of NetCallbacks) {
                if (callbacks.onMacLostCallback != undefined) {
                    callbacks.onMacLostCallback(net, lostmac, lostip);
                }
            }
            // NetCallbacks[plugin_name].onIPAddressLostCallback(id,lostip);
        }
        , function(net, mac, oldip, newip) {
            for (const callbacks of NetCallbacks) {
                if (callbacks.onIPChangedCallback != undefined) {
                    callbacks.onIPChangedCallback(net, mac, oldip, newip);
                }
            }
            // NetCallbacks[plugin_name].onIPAddressChangedCallback(id,oldip,newip);
        }
    );
};
exports.init = init;

// Returns promise
exports.getMACFromIPv4Address_Forward = function(net, ip, bSearch) {
    return ipv4.getMACFromIPv4Address(net, ip, bSearch);
};

// callbacks_obj can contain the following four members
// onMacFoundCallback   : function(net,newmac,newip);
// onMacLostCallback    : function(net,lostmac,lostip);
// onIPChangedCallback  : function(net,mac,oldip,newip);
const NetCallbacks = {};
exports.setNetCallbacks_Forward = function(pluginName, callbacksObj) {
    NetCallbacks[pluginName] = callbacksObj;
};

exports.getMACs = function(bSelfOnly) {
    return ipv4.getMACs(bSelfOnly);
};


/**
 * onCall handler of plugin
 * @param {string} method Caller method, accept GET only.
 * @param {string} path Plugin URL path
 * @param {object} args parameters of this call
 * @return {object} Returns a Promise object or object containing the result
 */
function onProcCall(method, path /* devid , propname*/, args) {
    switch (method) {
    case 'GET':
        return onProcCallGet(method, path /* devid , propname*/, args);
    /* case 'POST' :
        if(devid!='settings' || args == undefined)
            return {error:'The format is wrong for settings.'};
        if( args.schedule instanceof Array && logger.updateschedule(args.schedule) )
            return {success:true,message:'New schedule settings are successfully saved'};
        else
            return {error:'Error in saving scheduled logging'};*/
    }
    const msg = `The specified method ${method}`
          + ' is not implemented in admin plugin.';
    return {error: msg};
}
exports.onCall = onProcCall;

/**
 * onCall handler of plugin for GET method
 * @param {string} method Caller method, accept GET only.
 * @param {string} path Plugin URL path
 * @param {object} args parameters of this call
 * @return {object} Returns a Promise object or object containing the result
 */
function onProcCallGet(method, path, args) {
    // console.log('onProcCallGet('+JSON.stringify(arguments));
    let pathSplit = path.split('/');
    const serviceid = pathSplit.shift();
    const propname = pathSplit.join('/');

    if (serviceid == '') { // access 'admin/' => service list
        let re = {net: {}, server_status: {}};
        re.net = ipv4.getMACs();

        if (args.option === 'true') {
            re.net.option = {
                leaf: false,
                doc: {short: 'Mac address of recognized network peers'},
            };
            re.server_status.option={
                leaf: true,
                doc: {short: 'Check server memory/swap status'},
            };
        }

        return re;
    }

    if (propname == '') { // access 'admin/serviceid/' => property list
        let ret;
        switch (serviceid) {
        case 'net':
            const macs = ipv4.getMACs();
            // log(JSON.stringify(macs));
            ret = macs;
            for (const [mac, macinfo] of Object.entries(macs)) {
                if (args.option === 'true') {
                    ret[mac].option = {
                        leaf: true,
                        doc: {short: (macinfo.ip || 'IP:null')},
                    };
                }
            }
            return ret;
        case 'server_status':
            return new Promise((ac, rj)=>{
                exec('vmstat', (err, stdout, stderr) => {
                    if (err) {
                        ac({error: 'Command execution failed.',
                            result: err});
                    } else if (stdout !== null) {
                        ac({success: true, result: stdout.split('\n')});
                    } else {
                        ac({error: 'Command execution failed.',
                            result: stderr});
                    }
                });
            });
        }
        return {error: 'No such service:'+serviceid};
    }

    switch (serviceid) {
    case 'net':
        const m = ipv4.getMACs()[propname];
        if (m == undefined) {
            return {error: 'No such mac address:'+propname};
        }
        return m;
    }
    return {error: 'No such service:'+serviceid};
}


/**
 * Get settings schema
 * @param {object} schemaJson default settings schema
 * @param {object} curSettings current settings
 * @return {object} schema json or Promise
 */
async function onUIGetSettingsSchema(schemaJson, curSettings) {
    const pi = pluginInterface;
    const localStorage = pi.localStorage;
    const readJSON = (basename) => {
        return JSON.parse(pi.pluginfs.readFileSync(basename).toString());
    };
    const schemaDefaultJson = readJSON('settings_schema_default.json');
    const schemaWlanJson = readJSON('settings_schema_wlan.json');
    if (!curSettings) curSettings = {};
    curSettings.api_filter = {};
    let setProp = {};// schema_json.properties;
    for (let i=0; i<localStorage.length; i++) {
        const clname = localStorage.key(i);
        const filter = localStorage.getItem(clname).filter;
        setProp[clname] = {
            title: clname+' client allowed path in regexp',
            type: 'string',
        };
        if (localStorage.getItem(clname).filter != null) {
            setProp[clname].default = filter;
        }

        curSettings.api_filter[clname] = filter;
    }
    schemaJson.properties.api_filter.properties = setProp;


    return listNetInterfaces().then((interfaces, bWlanExist) => {
        let curInterf;
        let curAp;
        if (typeof curSettings.interfaces == 'object') {
            for (let k of Object.keys(curSettings.interfaces)) {
                curInterf = k;
                if (k.indexOf('wlan')==0) {
                    curAp = curSettings.interfaces[k].apname;
                }
            }
        }

        // Previously set interface does not exist any more..
        if (curInterf != undefined && interfaces.indexOf(curInterf)<0) {
            log(`Previously set interface ${curInterf} does not exist now`);
            interfaces.unshift(curInterf);
        }

        interfaces.forEach((interf)=>{
            let prop = {};

            prop[interf] = (interf.indexOf('wlan')==0 ?
                schemaWlanJson : schemaDefaultJson);

            schemaJson.properties.interfaces.oneOf.push({
                title: interf,
                type: 'object',
                additionalProperties: false,
                properties: prop,
            });
        });

        if (schemaJson.properties.interfaces.oneOf.length==0) {
            throw new Error({error: 'No network available.'});
        }

        if (!bWlanExist) {
            return schemaJson;
        }

        return scanWiFi().then((aps) => {
            const enumap = schemaWlanJson.properties.apname.enum;
            for (const ap of aps) {
                enumap.push(ap);
            }
            if (enumap.length == 0) {
                log('No valid Wifi IP found.');
            }
            if (curAp !=undefined && enumap.indexOf(curAp)<0) {
                log(`Previously set AP ${curAp} is invisible now`);
                enumap.unshift(curAp);
            }
            return schemaJson;
        });
    }).catch((err) => {
        delete schemaJson.properties.interfaces;
        delete schemaJson.properties.detail;
        delete schemaJson.properties.root_passwd;
        /* eslint-disable max-len */
        schemaJson.properties.network_settings = {
            type: 'object',
            description:
`nmcli should be installed to setup network configuration. Execute

"$ sudo apt-get install network-manager"

or

"$ sudo yum install NetworkManager"

Also, you need to free your network devices from existing framework by, for example, edit /etc/network/interfaces to contain only two lines:

"auto lo",
"iface lo inet loopback"

and reboot. In addition, you may want to uninstall dhcpcd5 (if exist) by

"$ sudo apt-get purge dhcpcd5"`,
        };
        /* eslint-enable max-len */
        return schemaJson;
    });
}
exports.onUIGetSettingsSchema = onUIGetSettingsSchema;


/**
 * Setting value rewriting event for UI
 * @param {object} newSettings Settings edited for UI
 * @return {object} Settings to save
 */
function onUISetSettings(newSettings) {
    return new Promise((ac, rj)=>{
        const pi = pluginInterface;
        if (newSettings.server_port != -1) {
            pi.publish('client_settings', {port: newSettings.server_port});
        }

        for (const clName of Object.keys(newSettings.api_filter)) {
            const clo = localStorage.getItem(clName);
            clo.filter = newSettings.api_filter[clName];
            localStorage.setItem(clName, clo);
        }

        if (newSettings.interfaces != null) {
            const rootPwd = newSettings.root_passwd;
            newSettings.root_passwd = ''; // Root password is not saved to the file
            // ac(newSettings);return;
            // log('NewSettings:');
            // log(JSON.stringify(newSettings,null,'\t'));

            let interf;
            for (const k of Object.keys(newSettings.interfaces)) {
                interf = k;
            }
            const ss = newSettings.interfaces[interf];

            const cname = NMCLI_CONNECTION_NAME_PREFIX + '_' + interf;
            let commands = [];
            // Delete connection (may fail for first time)
            commands.push(['nmcli', 'connection', 'down', cname]);
            commands.push(['nmcli', 'connection', 'delete', cname]);

            if (interf.indexOf('wlan')==0) {
                const manualap = ss.apname_manual.trim();
                commands.push([
                    'nmcli', 'connection', 'add', 'con-name', cname,
                    'type', 'wifi', 'ifname', interf, 'ssid',
                    (manualap.length==0 ? ss.apname : manualap)]);
            } else { // if( interf.indexOf('eth')==0 )
                commands.push([
                    'nmcli', 'connection', 'add', 'con-name', cname,
                    'type', 'ethernet', 'ifname', interf]);
            }


            if (newSettings.detail.ip == undefined) { // DHCP
                commands.push(['nmcli', 'connection', 'modify', cname,
                    'ipv4.method', 'auto']);
            } else { // static ip
                if (newSettings.detail.default_gateway == undefined) {
                    newSettings.detail.default_gateway = '';
                }
                const ipSetting =
                    (newSettings.detail.ip + ' '
                     + newSettings.detail.default_gateway).trim();
                commands.push(['nmcli', 'connection', 'modify', cname,
                    'ipv4.method', 'manual', 'ipv4.addresses', ipSetting]);
            }

            if (interf.indexOf('wlan')==0) {
                if (ss.password != ss.password2) {
                    rj('Password mismatch.');
                    return;
                }
                const apPwd = ss.password; ss.password = ss.password2 = '';
                commands.push(['nmcli', 'connection', 'modify', cname,
                    'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', apPwd]);
            }
            // commands.push(['nmcli','connection','down', cname]);
            commands.push(['nmcli', 'connection', 'up', cname]);

            if (newSettings.server_power != 'none') {
                commands.push([]); // Accept and save settings first
                if (newSettings.server_power == 'reboot') {
                    commands.push(['reboot']);
                }
                if (newSettings.server_power == 'shutdown') {
                    commands.push(['shutdown', '-h', 'now']);
                }
                newSettings.server_power = 'none';
            }

            // log('Commands:');
            // log(JSON.stringify(commands,null,'\t'));

            const ignoreErrorCmds = ['delete', 'down'];
            const ex = () => {
                if (commands.length==0) {
                    // ipv4.refreshMyAddress();
                    ac(newSettings);
                    return;
                }
                let cmd = commands.shift();
                if (cmd.length == 0) {
                    ac(newSettings); ex();
                    return;
                }
                // log('Exec:'+cmd.join(" "));
                let child = sudo(cmd, {password: rootPwd});
                child.stderr.on('data', (dat)=>{
                    let msg = 'Error in executing\n$ ';
                    msg += cmd.join(' ') + '\n' + dat.toString();
                    console.error(msg);
                    if (ignoreErrorCmds.indexOf(cmd[2]) >= 0) return;
                    msg = 'Error in executing\n\n$ ';
                    msg += cmd.join(' ') + '\n\n' + dat.toString();
                    rj(msg); // Interrupt execution
                    commands = [];
                });
                child.stdout.on('close', ()=>{
                    if (commands.length == 0) {
                        // ipv4.refreshMyAddress();
                        ac(newSettings);
                        return;
                    } else ex();
                });
            };
            ex();
        }
    });
}
exports.onUISetSettings = onUISetSettings;


/**
 * List Network Interfaces
 * @return {Promise} Return a list of network interfaces and whether you are using WiFi
 */
function listNetInterfaces() {
    return new Promise((ac, rj) => {
        exec('nmcli d', (err, stdout, stderr) => {
            const lines = stdout.split('\n');
            if (err || lines.length<2) {
                rj({error: 'No network available.'});
                return;
            }

            lines.shift();
            // Correct visible APs should be listed
            let bWlanExist = false;
            const interfaces = [];
            lines.forEach((line)=>{
                let sp = line.trim().split(/\s+/);
                if (sp.length < 4 || sp[0]=='lo') return; // Illegally formatted line
                if (sp[0].indexOf('wlan')==0) bWlanExist = true;
                interfaces.push(sp[0]);
            });

            ac(bWlanExist, interfaces);
        });
    });
}


/**
 * Scan WiFi network
 * @return {Promise} Return list of access points
 */
function scanWiFi() {
    return new Promise((ac) => {
        // WiFi scan
        exec('nmcli dev wifi list', (err, stdout, stderr) => {
            // eslint-disable-next-line max-len
            if (err) log('Cannot scan Wifi APs (possibly because "nmcli dev wifi list" command requires sudo?)');
            let lines = stdout.split('\n');
            const aps = [];
            lines.shift();
            lines.forEach((line)=>{
                let li = line.indexOf('Infra');
                if (li==-1) li = line.indexOf('インフラ');
                if (li==-1) return;
                let sp = line.slice(0, li).trim();
                if (sp[0]=='*') sp = sp.slice(1).trim();
                if (sp == '--') return;
                aps.push(sp);
            });
            ac(aps);
        });
    });
}

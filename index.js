
let log = console.log;
const ipv4 = require('./ipv4.js');
const sudo = require('./sudo.js');
const exec = require('child_process').exec;
const execSync = require('child_process').execSync;
const spawn = require('child_process').spawn;
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
            for (const callbacks of Object.values(NetCallbacks)) {
                if (callbacks.onMacFoundCallback != undefined) {
                    callbacks.onMacFoundCallback(net, newmac, newip);
                }
            }
            // NetCallbacks[plugin_name].onNewIDFoundCallback(newid,newip);
        }
        , function(net, lostmac, lostip) {
            for (const callbacks of Object.values(NetCallbacks)) {
                if (callbacks.onMacLostCallback != undefined) {
                    callbacks.onMacLostCallback(net, lostmac, lostip);
                }
            }
            // NetCallbacks[plugin_name].onIPAddressLostCallback(id,lostip);
        }
        , function(net, mac, oldip, newip) {
            for (const callbacks of Object.values(NetCallbacks)) {
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


    return listNetInterfaces().then(([interfaces, bWlanExist]) => {
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
async function onUISetSettings(newSettings) {
    const pi = pluginInterface;
    if (newSettings.server_port != -1) {
        pi.publish('client_settings', {port: newSettings.server_port});
    }

    for (const clName of Object.keys(newSettings.api_filter)) {
        const clo = localStorage.getItem(clName);
        clo.filter = newSettings.api_filter[clName];
        localStorage.setItem(clName, clo);
    }

    const rootPwd = newSettings.root_passwd;
    newSettings.root_passwd = ''; // Root password is not saved to the file

    if (!newSettings.interfaces) {
        return newSettings;
    }

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
    const ignoreErrorHandler = (cmd) => {
        const ignoreErrorCmds = ['delete', 'down'];
        return (ignoreErrorCmds.indexOf(cmd[2]) >= 0);
    };
    await executeCommands(
        commands,
        ignoreErrorHandler,
        {sudo: true, password: rootPwd},
    );

    commands = [];
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
    await executeCommands(
        commands, null, {sudo: true, password: rootPwd}
    ).then(() => {
        commands = [];
    }).catch((e) => {
        if (newSettings.detail.ip == undefined) { // DHCP
            throw e;
        }
        // static ip
        // The new version 'nmcli' has changed ipv4.gateway format
        commands = [];
        commands.push([
            'nmcli', 'connection', 'modify', cname,
            'ipv4.method', 'manual',
            'ipv4.addresses', newSettings.detail.ip,
            'ipv4.gateway', newSettings.detail.default_gateway]);
    });
    if (commands.length > 0) {
        await executeCommands(commands, null, {sudo: true, password: rootPwd});
        commands = [];
    }

    if (interf.indexOf('wlan')==0) {
        if (ss.password != ss.password2) {
            throw new Error('Password mismatch.');
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


    await executeCommands(
        commands,
        ignoreErrorHandler,
        {sudo: true, password: rootPwd},
    );
    return newSettings;
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

            ac([interfaces, bWlanExist]);
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


/**
 * Set static route to ipv4 network
 * @param {string} target : the destination network or host. e.g. 224.0.23.0/32
 * @param {string} gatewayIP : gateway IP address
 * @param {string} rootPwd : root password for executing sudo
 * @return {Promise} Return last command output
 */
async function routeSet(target, gatewayIP, rootPwd) {
    let deleteCmds;
    const prevRoute = await searchPrevRoute(target);
    const connName = await searchConnName(gatewayIP);
    if (prevRoute) {
        if (prevRoute.connName === connName &&
            prevRoute.target === target &&
            prevRoute.gatewayIP === gatewayIP) {
            return; // no need to do anything
        }
        deleteCmds = [
            ['nmcli', 'connection', 'modify', prevRoute.connName,
                '-ipv4.routes', `${prevRoute.target} ${prevRoute.gatewayIP}`],
            ['nmcli', 'connection', 'down', prevRoute.connName],
            ['nmcli', 'connection', 'up', prevRoute.connName],
        ];
    }

    let cmds = [
        ['nmcli', 'connection', 'modify', connName,
            '+ipv4.routes', `${target} ${gatewayIP}`],
        ['nmcli', 'connection', 'down', connName],
        ['nmcli', 'connection', 'up', connName],
    ];
    if (deleteCmds) {
        cmds = deleteCmds.concat(cmds);
    }
    return await executeCommands(cmds, null, {sudo: true, password: rootPwd});


    // eslint-disable-next-line require-jsdoc
    async function searchPrevRoute(target) {
        const connNames = await listConnectionNames();
        for (const connName of connNames) {
            const cmd = [
                'nmcli', '-f', 'IP4.ROUTE', 'connection', 'show', connName,
            ];
            const output = await executeCommand(cmd);
            for (const line of output.split('\n')) {
                const exs = `dst\\s*=\\s*${target},\\snh\\s*=\\s*([\\d\.]+)`;
                const re = line.match(new RegExp(exs));
                if (!re) {
                    continue;
                }
                return {
                    connName: connName,
                    target: target,
                    gatewayIP: re[1],
                };
            }
        }
        return null;
    }

    // eslint-disable-next-line require-jsdoc
    async function searchConnName(gatewayIP) {
        const connNames = await listConnectionNames();
        const gipnum = ipv4.convToNum(gatewayIP);
        for (const connName of connNames) {
            const cmd = [
                'nmcli', '-f', 'IP4.ADDRESS', 'connection', 'show', connName,
            ];
            const output = await executeCommand(cmd);
            for (const line of output.split('\n')) {
                const re = line.match(/\s+([\d\.]+)\/([\d]+)/);
                if (!re) {
                    continue;
                }
                const ip = ipv4.convToNum(re[1]);
                const mask = parseInt(re[2]);
                if ((ip & mask) == (gipnum & mask)) {
                    return connName;
                }
            }
        }
        return null;
    }
}
exports.routeSet = routeSet;

/**
 * List connection names with device name
 * @return {Array.<object>} Return list of connection name and device name
 */
async function listConnectionNames() {
    // Obtain nmcli connection name for newnet.
    const connList = await executeCommand(
        ['nmcli', '-f', 'NAME,DEVICE', '-t', 'connection', 'show']);
    const ret = connList.split('\n').map((l) => {
        const [name] = l.split(/:/);
        return name;
    }).filter((name) => {
        return name;
    });
    return ret;
}


/**
 * Execute command with sudo
 * @param {Array.<string>} commands : Array of command list
 * @param {object} [option] : option parameter
 * @param {Promise} Return stdout strings
 */
function executeCommand(cmd, option) {
    option = option || {};
    return new Promise((ac, rj)=>{
        let okMsg = '';
        let erMsg='';
        console.log('Exec:'+cmd.join(' '));
        let child;
        if (option.sudo) {
            child = sudo(cmd, {password: option.password});
        } else {
            child = spawn(cmd[0], cmd.slice(1));
        }
        child.stdout.on('data', (dat)=>{
            okMsg += dat.toString();
        });
        child.stderr.on('data', (dat)=>{
            erMsg += dat.toString();
        });
        child.on('close', (code)=>{
            if (code == 0) {
                ac(okMsg);
            } else {
                rj('Error in executing\n'
                   +'$ '+cmd.join(' ')+'\n\n'
                   + erMsg);
            }
        });
        child.on('error', (err)=>{
            rj(err);
        });
    });
}

/**
 * Execute commands with sudo
 * @param {Array.<Array.<string>>} commands : Array of command list
 * @param {function} ignoreErrorFunc : Handler for determining whether to ignore when command fails
 * @param {object} [option] : option parameter
 * @param {Promise} Return standard output of each command as an array
 */
async function executeCommands(commands, ignoreErrorFunc, option) {
    const ret = [];
    for (const cmd of commands) {
        const r = await executeCommand(cmd, option).catch((e) => {
            if (ignoreErrorFunc && ignoreErrorFunc(cmd)) {
                // ignore error
                return '';
            }
            throw e;
        });
        ret.push(r);
    }
    return ret;
}

/**
 * Check if NetworkManager is installed
 * @return {boolean} If true, it is installed
 */
function supportedNetworkManager() {
    try {
        execSync('nmcli connection');
        return true;
    } catch (e) {
        return false;
    }
}
exports.supportedNetworkManager = supportedNetworkManager;


/**
 * Return the network list for each interface
 * @return {object} network list
 */
function getNetworkInterfaces() {
    return ipv4.getNetworkInterfaces();
}
exports.getNetworkInterfaces = getNetworkInterfaces;


/**
 * Look for the network interface from the IP address
 * @param {string} ip : IP address
 * @param {object} [networks] : List of my network interfaces. This is the same as getNetworkInterfaces() 's return value.
 * @return {string} network interface. e.g. 'eth0' or 'wlan0'
 */
function searchNetworkInterface(ip, networks) {
    return ipv4.searchNetworkInterface(ip, networks);
}
exports.searchNetworkInterface = searchNetworkInterface;

/**
 * Start checking the arp table
 */
function startCheckingArpTable() {
    ipv4.startCheckingArpTable();
}
exports.startCheckingArpTable = startCheckingArpTable;

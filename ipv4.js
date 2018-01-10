const CHECK_ARP_TABLE_AND_PING_INTERVAL = 60*1000;
const PING_TIMEOUT_IN_SEC = 7;

const arped = require('arped');
const ping = require('ping');
const os = require('os');

// //////////////////////////////////////////
//   Exported methods
// //////////////////////////////////////////

// return: { mymac1:{net:net,ip:ip,self:(true|undefined)} , mymac2:{} ... }
// It also outputs available nets.
exports.getMACs = function(bSelfOnly) {
    if (bSelfOnly !== true) return objCpy(macs);
    let ret = {};
    for (const [mac, macinfo] of Object.entries(macs)) {
        if (macinfo.self === true) {
            ret[mac] = macinfo;
        }
    }
    return objCpy(ret);
};

// eslint-disable-next-line require-jsdoc
function objCpy(src) {
    return JSON.parse(JSON.stringify(src));
    // return Object.assign({},src);
}

// If the third param is true, corresponding mac is searched
// by pinging to
exports.getMACFromIPv4Address = function(net, ip, bSearch) {
    return new Promise((ac, rj) => {
        const checkInCache = () => {
            for (const [mac, macinfo] of Object.entries(macs)) {
                if (macinfo.net == net && macinfo.ip == ip) {
                    ac(mac);
                    return true;
                }
            }
        };
        if (checkInCache() === true) return; // Found. accepted.

        // No corresponding ip in cache.
        chkArpTable();
        if (checkInCache() === true) return; // Found. accepted.

        if (!bSearch) {
            rj({error: 'Not found in arp table.'});
            return;
        }

        // Not listed in arp table. try ping to list the ip on arp table.
        pingNet(net, ip).then((bActive)=>{
            chkArpTable();
            if (checkInCache() === true) return; // Found. accepted.
            rj({error: 'Timeout'});
        }).catch(()=>{
            rj({error: 'Ping error'});
        });
    });
};

exports.setNetCallbackFunctions = function(
    _onMacFoundCallback, _onMacLostCallback, _onIPChangedCallback) {
    onMacFoundCallback =
        _onMacFoundCallback || function(net, newmac, newip) {};
    onMacLostCallback =
        _onMacLostCallback || function(net, lostmac, lostip) {};
    onIPChangedCallback =
        _onIPChangedCallback || function(net, mac, oldip, newip) {};
};

exports.convToNum = convToNum;


// ///////////////////////////////////////////
// //   Exports ended
// ///////////////////////////////////////////

let macs = {};
let onMacFoundCallback;
let onMacLostCallback;
let onIPChangedCallback;


// Initialize
exports.setNetCallbackFunctions(
    function(net, newmac, newip) {
        log(`onMacFoundCallback("${net}","${newmac}","${newip}")`);
    }
    , function(net, lostmac, lostip) {
        log(`onMacLostCallback("${net}","${lostmac}","${lostip}")`);
    }
    , function(net, mac, oldip, newip) {
        log(`onIPChangedCallback("${net}","${mac}","${oldip}","${newip}")`);
    }
);


// ///////////////////////////////////////////
// /   Utility functions
// ///////////////////////////////////////////


// eslint-disable-next-line require-jsdoc
function log(msg) {
    if (typeof(msg)=='object') console.log(JSON.stringify(msg, null, '\t'));
    else console.log(msg);
}

// eslint-disable-next-line require-jsdoc
function pingNet(net, ip) {
    return new Promise((ac, rj)=>{
        try {
            let params = {timeout: PING_TIMEOUT_IN_SEC};
            switch (process.platform) {
            case 'win32':
            case 'win64': // Never hits
                break;
            case 'darwin':
            case 'freebsd':
                params.extra = ['-S', net];
                break;
            default:
                params.extra = ['-I', net];
                break;
            }

            ping.sys.probe(ip, ac, params);
        } catch (e) {
            rj(e);
        } ;
    });
}

// eslint-disable-next-line require-jsdoc
function isNetworkSame(maskstr, ip1str, ip2str) {
    let mask = convToNum(maskstr);
    let ip1 = convToNum(ip1str);
    let ip2 = convToNum(ip2str);
    return (ip1&mask) == (ip2&mask);
}


/**
 * Convert to number value from string IP address
 * @param {string} ipstr : string IP address
 * @return {number} number value of IP address
 */
function convToNum(ipstr) {
    let ret = 0;
    let mul = 256*256*256;
    ipstr.split('.').forEach((numstr)=>{
        ret += parseInt(numstr)*mul;
        mul >>= 8;
    });
    return ret;
}


// eslint-disable-next-line require-jsdoc
function chkArpTable() {
    let oldmacs = macs;

    try {
        macs = {};

        // Check arp text
        // log('Checking arp table..') ;
        let newobj = arped.parse(arped.table());
        // log('ARP table object:') ; log(newobj,null,"\t") ;

        // Register new mac address and corresponding IP
        let nets = {}; // Used only for windows env.
        for (const [net, device] of Object.entries(newobj.Devices)) {
            for (const [mac, ip] of Object.entries(device.MACs)) {
                if (mac === '00:00:00:00:00:00' ||
                    mac === 'ff:ff:ff:ff:ff:ff') {
                    continue;
                }
                macs[mac] = {net: net, ip: ip};
                if (nets[net] == null) { // Believe the first device is truly in this net. (Inprecise. Windows only)
                    nets[net] = macs[mac].ip;
                }
            }
        }

        // Trace self info
        // log('Checking self MACs/IPs..') ;
        let ifaces = os.networkInterfaces();
        // log('networkInterfaces object:') ; log(ifaces) ;
        for (const [_mynet, iface] of Object.entries(ifaces)) {
            iface.forEach((iinfo)=>{
                if (iinfo.family !== 'IPv4' || iinfo.internal === true) return;
                macs[iinfo.mac] = {net: _mynet, ip: iinfo.address, self: true};

                let mynet = _mynet;

                if (process.platform.indexOf('win') == 0 &&
                    nets[mynet] == null) {
                    // New network? Net name different? (No way to tell because network name
                    // in arp and os.networkInterface can be different.)
                    for (const [net, ip] of Object.entries(nets)) {
                        // Seems to be in the same net... network name is copied from
                        // arp one.
                        if (isNetworkSame(iinfo.netmask, iinfo.address, ip)) {
                            macs[iinfo.mac].net = net;
                            mynet = net;
                            break;
                        }
                    }
                }

                // Check devices are really in this network. (only happens in windows)
                for (const mac of Object.keys(macs)) {
                    if (macs[mac].net != mynet) {
                        continue;
                    }
                    const same = isNetworkSame(
                        iinfo.netmask, iinfo.address, macs[mac].ip);
                    if (!same) {
                        delete macs[mac];
                    }
                }
            });
        }

        // Differenciate and call external callbacks for network change.
        // Compare new arp => old arp
        for (const mac of Object.keys(macs)) {
            if (oldmacs[mac] == null) {
                // New mac appeared
                onMacFoundCallback(macs[mac].net, mac, macs[mac].ip);
            } else if (oldmacs[mac].net !== macs[mac].net) {
                // Network changed
                onMacLostCallback(oldmacs[mac].net, mac, oldmacs[mac].ip);
                onMacFoundCallback(macs[mac].net, mac, macs[mac].ip);
                delete oldmacs[mac];
            } else if (oldmacs[mac].ip !== macs[mac].ip) {
                // IP address changed
                onIPChangedCallback(
                    macs[mac].net, mac, oldmacs[mac].ip, macs[mac].ip);
                delete oldmacs[mac];
            } else {
                // mac,net,ip are the same.
                delete oldmacs[mac];
            }
        }

        // Compare old arp => new arp (remains losts.)
        for (const [mac, macinfo] of Object.entries(oldmacs)) {
            onMacLostCallback(macinfo.net, mac, macinfo.ip);
        }

        // log('New macs:'); log(macs);
    } catch (e) {
        macs = oldmacs;
        log('An error occurred in checkArpTable');
        log(e);
    }
}

setInterval(()=>{
    chkArpTable();
    for (const macinfo of Object.values(macs)) {
        pingNet(macinfo.net, macinfo.ip);
    }
}, CHECK_ARP_TABLE_AND_PING_INTERVAL);

// Initial check
chkArpTable();

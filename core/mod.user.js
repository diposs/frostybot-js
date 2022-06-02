// User Module

const frostybot_module = require('./mod.base')
var context = require('express-http-context');
var speakeasy = require('speakeasy');
var qrcode = require('qrcode');

module.exports = class frostybot_user_module extends frostybot_module {

    // Constructor

    constructor() {
        super()
        this.description = 'User Management Module'
    }

    // Register methods with the API (called by init_all() in core.loader.js)

    register_api_endpoints() {

        // Permission templates for reuse
        var templates = {
            'localonly': { 'standard': ['local' ], 'provider': ['local' ]  },
            'tokenonly': { 'standard': ['token'],  'provider': ['token']   },
            'normal':    { 'standard': ['core,singleuser','multiuser,user','token'], 'provider': ['token'] },
            'any':       { 'standard': ['any'], 'provider': ['any'] }
        }

        // Method permissions 

        var permissions = {
            'user:multiuser_enable':    templates.localonly,
            'user:multiuser_disable':   templates.localonly,
            'user:enable_2fa':          templates.tokenonly,
            'user:disable_2fa':         templates.tokenonly,
            'user:verify_2fa':          templates.tokenonly,
            'user:register':            templates.any,
            'user:login':               templates.any,
            'user:logout':              templates.tokenonly,
            'user:add':                 templates.localonly,
            'user:delete':              templates.localonly,
            'user:change_password':     templates.tokenonly,
            'user:reset':               templates.localonly,
            'user:log':                 templates.normal,
        }


        // API method to endpoint mappings
        var api = {
            'user:multiuser_enable':    'post|/user/multiuser/enable',  // Enable multiuser mode (for hosted solutions)
            'user:multiuser_disable':   'post|/user/multiuser/disable', // Disable multiuser mode 
            'user:enable_2fa':          'post|/user/:uuid/2fa/enable',  // Enable 2FA for a specific user (GUI)
            'user:disable_2fa':         'post|/user/:uuid/2fa/disable', // Disble 2FA for a specific user (GUI)
            'user:verify_2fa':          'post|/user/:uuid/2fa/verify',  // Verify 2FA for a specific user (GUI)
            'user:register':            'post|/user/register',          // New user registration (GUI)
            'user:login':               'post|/user/login',             // User Login (GUI)
            'user:logout':              'post|/user/logout',            // User Logout (GUI)
            'user:add':                 'post|/user',                   // Add new user (Non-GUI)
            'user:delete':              'delete|/user/:uuid',           // Delete user (Non-GUI)
            'user:change_password':     'post|/user/:uuid/password',    // User Password Change (GUI)
            'user:reset':               'post|/user/:uuid/reset',       // User Password Reset (Non-GUI)
            'user:log':                 'post|/user/:uuid/log',         // Retrieve user logs
        }

        // Register endpoints with the REST and Webhook APIs
        for (const [method, endpoint] of Object.entries(api)) {   
            this.register_api_endpoint(method, endpoint, permissions[method]); // Defined in mod.base.js
        }
        
    }

    // Check if any users have been created yet

    async no_users_yet() {
        var result = this.database.query('SELECT * FROM `users` LIMIT 1;');
        if (result.length > 0) 
            return false;
        return true;
    }

    // Enable Multi-User Mode

    async multiuser_enable(params) {
        //var ip = context.get('srcIp');
        //if (['127.0.0.1','::1',undefined].includes(ip)) {
            var schema = {
                email: {
                    required: 'string',
                },
                password: {
                    required: 'string'
                }
            }
    
            if (!(params = this.mod.utils.validator(params, schema))) return false; 
    
            var [email, password] = this.mod.utils.extract_props(params, ['email', 'password']);

            if (await this.core(email, password)) {
                if (await this.mod.settings.set('core','multiuser:enabled', true)) {
                    return this.mod.output.success('multiuser_enable');
                }
            }
            return this.mod.output.error('multiuser_enable');
        //}
        //return this.mod.output.error('local_only');
    }

    // Disable Multi-User Mode 

    async multiuser_disable(params = null) {
        var ip = context.get('srcIp');
        if (['127.0.0.1','::1',undefined].includes(ip)) {
            if (await this.mod.settings.set('core','multiuser:enabled', false)) {
                return this.mod.output.success('multiuser_disable');
            }
            return this.mod.output.error('multiuser_disable');
        }
        return this.mod.output.error('local_only');
    }


    // Check if Multi-User is Enabled

    async multiuser_isenabled() {
        //if (this.database.type != 'mysql') 
        //    return false;
        return await this.mod.settings.get('core', 'multiuser:enabled', false);
    }


    // Get user UUID by email address

    async uuid_by_email(email) {
        var result = await this.database.select('users', {email: email});
        if (result.length == 1)
            return result[0].uuid;
        else
            return false;
    }

    // Create a new user token

    async create_token(uuid) {
        var timeout = await this.mod.settings.get('core','gui:sessiontimeout', 3600);
        var duration = 23000 * timeout;
        var token = this.mod.encryption.new_uuid();
        var expiry = (new Date()).getTime() + duration;
        var result = await this.database.insertOrReplace('tokens', { uuid: uuid, token: token, expiry: this.mod.utils.ts_to_datetime(expiry)});
        if (result != false && result.changes > 0)
            return {
                uuid: uuid,
                token: token,
                expiry: expiry
            };
        return false;
    }    

    // Verify token

    async verify_token(param) {
        var uuid = param.uuid;
        var token = param.token;
        var result = await this.database.select('tokens', {uuid: uuid, token: token});
        if (result.length == 1) {
            var dbexpiry = new Date(result[0]['expiry']).getTime();
            var ts = (new Date()).getTime();
            if (ts < dbexpiry) {
                return true;
            }
        }
        return false;
    }

    // Set core user email and password

    async core(email, password) {
        var uuid = await this.mod.encryption.core_uuid();
        var password = await this.mod.encryption.encrypt(password, uuid);
        var data = {
            uuid: uuid,
            email: email,
            password: JSON.stringify(password)
        }
        if ((await this.database.insertOrReplace('users', data)).changes > 0)
            return true;
        else
            return false   
    }

    // User Registration

    async register(params) {

        var schema = {
            email: {
                required: 'string',
            },
            password: {
                required: 'string'
            }
        }

        if (!(params = this.mod.utils.validator(params, schema))) return false; 

        var [email, password] = this.mod.utils.extract_props(params, ['email', 'password']);

        if (await this.exists(email)) {
            return this.mod.output.error('user_exists', [email]);
        } else {
            var uuid = this.mod.encryption.new_uuid();
            var password = await this.mod.encryption.encrypt(password, uuid);
            var data = {
                uuid: uuid,
                email: email,
                password: JSON.stringify(password)
            }
            if ((await this.database.insert('users', data)).changes == 1)
                return this.mod.output.success('user_register', [email]);
        }

    }

    // Login user

    async login(params) {

        var schema = {
            email: {
                required: 'string'
            },
            password: {
                required: 'string'
            },
            token2fa: {
                optional: 'string'
            }
        }

        if (!(params = this.mod.utils.validator(params, schema))) return false; 

        var [email, password, token2fa] = this.mod.utils.extract_props(params, ['email', 'password', 'token2fa']);

        var result = await this.database.select('users', { email: email});
        if (result.length == 1) {
            var userdata = result[0];
            var uuid = userdata.uuid;
            var key2fa = await this.get_2fa(uuid);
            var decr_pass = await this.mod.encryption.decrypt(JSON.parse(userdata.password), uuid);
            if (password == decr_pass) {
                if (key2fa !== false) {
                    var verify = await this.verify_2fa(key2fa, token2fa);
                    if (verify === false)
                        return this.mod.output.error('invalid_token')
                }
                this.mod.output.success('user_auth', [email]);
                var token = await this.create_token(uuid);
                if (token !== false)
                    return token;
            }
        }
        return this.mod.output.error('user_auth', [email]);
    
    }

    // Logout

    async logout(params) {
        if (params.hasOwnProperty('token')) {
            var uuid = params.token.uuid;
            var token = params.token.token;
            var result = await this.database.delete('token', { uuid: uuid, token: token});
            if (result.changes > 0)
                return true;
        }
        return false;
    }

    // Change password

    async change_password(params) {

        var schema = {
            oldpassword: {
                required: 'string'
            },
            newpassword: {
                required: 'string'
            }
        }

        if (!(params = this.mod.utils.validator(params, schema))) return false; 

        var [uuid, oldpassword, newpassword] = this.mod.utils.extract_props(params, ['uuid', 'oldpassword', 'newpassword']);

        if (uuid == undefined)
            uuid = params.token.uuid;

        var result = await this.database.select('users', { uuid: uuid});
        if (result.length == 1) {
            var userdata = result[0];
            var uuid = userdata.uuid;
            var decr_pass = await this.mod.encryption.decrypt(JSON.parse(userdata.password), uuid);
            if (oldpassword == decr_pass) {
                var encr_pass = JSON.stringify(await this.mod.encryption.encrypt(newpassword, uuid));
                var result = await this.database.update('users', {password: encr_pass}, {uuid, uuid});
                if (result.changes > 0) {
                    return true;
                }
            }
        }

        return false;

    }

    // Enable 2FA for user

    async enable_2fa(params) {
        
        var [token, key, checktoken] = this.mod.utils.extract_props(params, ['token', 'key', 'checktoken']);

        var uuid = token.uuid;

        if (await this.verify_2fa(key, checktoken)) {
            var result = await this.database.update('users',  {'2fa': key}, { uuid: uuid });
            if (result.changes > 0) {
                return true;
            }
        }
        return false;
    }

    // Disable 2FA for user

    async disable_2fa(params) {

        var [token, checktoken] = this.mod.utils.extract_props(params, ['token', 'checktoken']);

        var uuid = token.uuid;

        if (await this.verify_2fa(uuid, checktoken)) {
            var result = await this.database.update('users',  {'2fa': 'false'}, { uuid: uuid });
            if (result.changes > 0) {
                return true;
            }
        }
        return false;
    }

    // Create new 2FA barcode

    async create_2fa_secret() {
        var secret = speakeasy.generateSecret({length: 20, name: 'FrostyBot'});
        var qrcodeurl = await qrcode.toDataURL(secret.otpauth_url);
        return {secret: secret, qrcode: qrcodeurl};
    }

    // Check if 2FA is enabled

    async get_2fa(uuid) {
        var result = await this.database.select('users', {uuid: uuid});
        if (result.length == 1) {
            var secret = result[0]['2fa'];
            if (String(secret) != "false")
                return secret;
        }
        return false;
    }

    // Test Verify 2FA Token Before 

    async verify_2fa(key, token) {
    
        if (key.length == 36)
            var secret = await this.get_2fa(key);
        else
            var secret = key;

        if (secret !== false) {
            var verified = speakeasy.totp.verify({
                secret: secret,
                encoding: 'base32',
                token: token
              });
            return verified;
        }
        return false;
    }

    // Check if user email address already exists

    async exists(email) {
        email = email.toLowerCase();
        var result = await this.database.select('users',  { email: email });
        if (result.length > 0) 
            return true;
        return false;
    }
    
    // Add New User (returns the user UUID)

    async add(params) {

        var schema = {
            email: {
                required: 'string',
            }
        }

        if (!(params = this.mod.utils.validator(params, schema))) return false; 

        var email = params.email;

        var uuid = await this.uuid_by_email(email);
        if (uuid !== false)
            return uuid;

        var user = {
            email    : String(email)
        };
        var result = await this.database.insertOrReplace('users',  user);
        if (result.changes > 0) {
            var uuid = await this.uuid_by_email(email);
            this.mod.output.success('multiuser_add', [uuid]);
            return uuid;
        }  
        return this.mod.output.error('multiuser_add', [email]);  
    }

    // Delete user

    async delete(params) {

        var schema = {
            uuid: {
                required: 'string',
            },
        }

        if (!(params = this.mod.utils.validator(params, schema))) return false; 

        var uuid = params.uuid;
        var result = await this.database.delete('users',  {uuid: uuid});
        if (result.changes > 0) {
            this.mod.output.success('multiuser_delete', [uuid]);
            return true;
        }  
        return this.mod.output.error('multiuser_delete', [uuid]);  
    }

    // Reset user password (CLI Only)

    async reset(params) {
    
        var ip = context.get('srcIp');

        if (['127.0.0.1','::1'].includes(ip)) {
    
            var schema = {
                email: {
                    required: 'string',
                },
                password: {
                    required: 'string'
                }
            }
    
            if (!(params = this.mod.utils.validator(params, schema))) return false; 
    
            var [email, password] = this.mod.utils.extract_props(params, ['email', 'password']);

            var useruuid = await this.uuid_by_email(email);
            if (useruuid !== false) {
                var encr_pass = JSON.stringify(await this.mod.encryption.encrypt(password, useruuid));
                var result = await this.database.update('users', {password: encr_pass}, {uuid: useruuid});
                if (result.changes > 0) {
                    return true;
                }
            }
            return false;
        } else {
            return this.mod.output.error('local_only');         
        }
    }

    // Get User Log

    async log(params) {

        if (!params.hasOwnProperty('uuid'))
            params.uuid = context.get('uuid');
 
        var schema = {
            uuid: {
                required: 'string',
            },
        }

        if (!(params = this.mod.utils.validator(params, schema))) return false; 

        var uuid = params.uuid;
        var filterstr = (params.hasOwnProperty('filters') ? params.filters : 'debug,notice,warning,error,success') + ',_';
        var filters = filterstr.split(',');
        if (!Array.isArray(filters) && typeof(filters) == 'string') { filters = [ filters ]; }
        var result = await this.database.select('logs', {uuid: uuid}, 1000);
        var output = [];
        if (result.length > 1) {
            for (var i = 0; i < result.length; i++) {
                var row = result[i];
                var date = new Date(row.timestamp);
                row.timestamp = date.toISOString()
                if (filters.includes(row.type)) 
                    output.push(row);
            }
            return output;
            //return result;
        }  
        return this.mod.output.error('log_retrieve', [uuid]);  
    }

    // Get log tail

    async logtail(params) {
        var timestamp = parseInt(params.ts);
        var dt = new Date(timestamp);
        var datetime = dt.toISOString().substr(0,19).replace('T', ' ');
        //var datetime = this.mod.utils.to_mysqldatetime(dt);
        var result = await this.database.query("SELECT * FROM `logs` WHERE uuid='" + params.user + "' AND `timestamp` > '" + datetime + "' limit 500;");
        if (result.length > 1) {
            return result;
        }  
        return [];
    }

    // Extract UUID from params

    async uuid_from_params(params) {
        var multiuser = await this.multiuser_isenabled();
        var core_uuid = await this.mod.encryption.core_uuid();
        var params_uuid = params.hasOwnProperty('uuid') ? params.uuid : (multiuser ? undefined : core_uuid);
        var token_uuid = params.hasOwnProperty('token') ? (params.token.hasOwnProperty('uuid') ? params.token.uuid : undefined) : undefined
        if (token_uuid != undefined) {
            return {
                type: 'token',
                uuid: token_uuid
            }
        } else {
            if (params_uuid != undefined) {
                if (params_uuid == core_uuid) {
                    return { 
                        type: 'core',
                        uuid: params_uuid
                    }
                } else {
                    return {
                        type: 'user',
                        uuid: params_uuid
                    }
                }
            }            
        }
        return false;
    }
  

};

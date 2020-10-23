// Accounts Handling Module

module.exports = {  


    // Initialize Module

    initialize() {
        if (this.initialized !== true) {
            this.modules();
        }
        this.initialized = true;
    },


    // Create module shortcuts

    modules() {
        for (const [method, module] of Object.entries(global.frostybot.modules)) {
            if (method != 'accounts') this[method] = module;
        }
    },

    // Get account silently (no log output, used internally)

    getaccount(stub) {
        this.initialize();
        var account = this.settings.get('accounts', stub, false);
        if (account) {
            return this.utils.lower_props(account)
        }
        return false;
    },    

    // Get account(s)

    async get(params) {
        var stub = this.utils.extract_props(params, 'stub');
        if (stub == null) {
            var accounts = this.settings.get('accounts');
            if (accounts) {
                for (const [stub, account] of Object.entries(accounts)) {
                    accounts[stub] = this.utils.lower_props(account);
                }
                this.output.success('account_retrieve');
                return this.censored(accounts);
            }
            return this.output.error('account_retrieve');
        }  else {
            var account = this.settings.get('accounts', stub, false);
            if (account) {
                var accounts = {};
                accounts[stub] = this.utils.lower_props(account)
                this.output.success('account_retrieve', stub);
                return this.censored(accounts);
            }
            return this.output.error('account_retrieve', stub);
        }
    },

    // Censor account output

    censored(accounts) {
        var result = {};
        if (accounts != false) {
            for (var [stub, account] of Object.entries(accounts)) {
                if (account != false) {
                    account = this.utils.censor_props(account, ['apikey', 'secret']);
                }
                result[stub] = account;
            }
            return result;
        }
    },


    // Check if account stub exists

    exists(stub) {
        var account = this.settings.get('accounts', stub, false);
        if (account) {
            return true;
        }
        return false;
    },


    // Extract CCXT Test Parameters 

    create_params(params) {
        const stub = params.stub.toLowerCase();
        const description = params.hasOwnProperty('description') ? params.description : params.exchange;
        const exchange = params.exchange.toLowerCase();
        delete params.stub;
        delete params.description;
        delete params.exchange;
        var data = {
            description: description,
            exchange: exchange,
            parameters: params,
        }
        return [stub, data];
    },

    // Create new account

    async create(params) {

        var schema = {
            stub: {        required: 'string', format: 'lowercase' },
            exchange: {    required: 'string', format: 'lowercase' },
            description: { optional: 'string'  },
            apikey: {      required: 'string'  },
            secret: {      required: 'string'  },
            testnet: {     optional: 'boolean' },
            subaccount: {  optional: 'string'  },
            type: {        optional: 'string', format: 'lowercase' },
        }

        if (!(params = this.utils.validator(params, schema))) return false; 

        var [stub, data] = this.create_params(params);
        let testresult = await this.test(data);
        if (testresult) {
            if (this.settings.set('accounts', stub, data)) {
                this.output.success('account_create', stub);
                return true;
            }
            this.output.error('account_create', stub);
        }
        return false;
    },


    // Alias for create

    async add(params) {
        return await this.create(params);
    },


    // Update account

    async update(params) {
        var [stub, data] = this.create_params(params);
        let testresult = await this.test(data);
        if (testresult) {
            this.output.success('account_test', stub);
            if (this.settings.set('accounts', stub, data)) {
                this.output.success('account_update', stub);
            }
            this.output.error('account_update', stub);
        }
        this.output.error('account_test', stub);
        return false;
    },


    // Delete account

    async delete(params) {

        var schema = {
            stub: { required: 'string', format: 'lowercase' }
        }

        if (!(params = this.utils.validator(params, schema))) return false; 


        var stub = (params.hasOwnProperty('stub') ? params.stub : null);
        if (stub != null) {
            if (this.settings.delete('accounts', stub)) {
                this.output.success('account_delete', stub);
                return true;
            }
        }
        this.output.error('account_delete', stub);
        return false;
    },


    // Alias for delete

    async remove(params) {
        return await this.delete(params);
    },


    // Get account connection info

    ccxtparams(account) {

        const ccxtlib = require ('ccxt');
        if (!account.hasOwnProperty('parameters')) {
            var stubs = Object.getOwnPropertyNames(account);
            if (stubs.length == 1) {
                account = account[stubs[0]];
            }
        }

        var testnet = account.parameters.hasOwnProperty('testnet') ? String(account.parameters.testnet) == "true" : false;
        var subaccount = account.parameters.hasOwnProperty('subaccount') ? account.parameters.subaccount : null;

        var result = {
            exchange: account.hasOwnProperty('exchange') ? account.exchange : null,
            description: account.hasOwnProperty('description') ? account.description : null,
            parameters: {
                apiKey:     account.parameters.hasOwnProperty('apikey')     ? account.parameters.apikey     : null,
                secret:     account.parameters.hasOwnProperty('secret')     ? account.parameters.secret     : null,
                urls:       {},
                //type:       account.parameters.hasOwnProperty('type')       ? account.parameters.type       : null,
            },   
        }
        if ((result.exchange == 'ftx') && (subaccount != null)) {
            result.parameters.headers = {
                'FTX-SUBACCOUNT': subaccount
            };
        }
        const exchangeId = account.exchange;
        const exchangeClass = ccxtlib[exchangeId];
        const ccxtobj = new exchangeClass ();
        const ccxturls = ccxtobj.urls;
        result.parameters.urls = ccxturls;
        if (testnet) {
            if (ccxturls.hasOwnProperty('test')) {
                const url = ccxturls.test;
            } else {
                this.output.translate('warning', 'testnet_not_avail', this.utils.uc_first(result.exchange));
                const url = ccxturls.api;
            }
        } else {
            const url = ccxturls.api;
        }
        return result;
    },


    // Test account

    async test(params) {
        if (params.hasOwnProperty('stub')) {
            var account = await this.getaccount(params.stub);
        } else {
            var account = params;
        }
        const ccxtlib = require ('ccxt');
        var ccxtparams = this.ccxtparams(account);
        const accountParams = ccxtparams.parameters;
        const exchangeId = account.exchange;
        const exchangeClass = ccxtlib[exchangeId];
        const ccxtobj = new exchangeClass (accountParams);
        try {
            let result = await ccxtobj.fetchBalance();
        } catch (e) {
            if (e.name == 'AuthenticationError') {
                this.output.error('account_test');
                return false;
            }
        } 
        this.output.success('account_test');
        return true;
    },


    // Get exchange ID from stub

    get_exchange_from_stub(stub) {
        var account = this.getaccount(stub);
        if (account !== false) {
            var ccxtparams = this.ccxtparams(account);
            return ccxtparams.exchange;
        }
        return false;
    }


}
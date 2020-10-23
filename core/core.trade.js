// Trade Handling Module

const e = require("express");


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
            if (method != 'trade') this[method] = module;
        }
    },


    // Initialize exchange handler

    initialize_exchange(params) {
        this.initialize();
        if (params.stub != undefined) {
            const stub = params.stub;
            this.exchange = new this.classes.exchange(stub);
        }
    },


    // Check if an order is an advanced order (layered orders, relative pricing, etc)

    order_is_advanced(price) {
        return this.price_is_layered(price) || this.is_relative(price);
    },


    // Check if order pricing is layered

    price_is_layered(price) {
        return (String(price).indexOf(',') > 0 ? true : false);
    },


    // Check if number is relative (starts with + or -)

    is_relative(num) {
        return (['+','-'].includes(String(num).substr(0,1)) ? true : false);
    },

    // Flip relative price
    flip_relative(num) {
        if (num == undefined) return undefined
        if (!this.is_relative(num)) return num
        var operator = this.get_operator(num)
        flip = operator == '+' ? '-' : '+';
        return num.replace(operator, flip);
    },

    // Round a number to a given precision

    round_num(num, precision) {
        return (Math.round(num / precision) * precision).toFixed(this.utils.num_decimals(precision));
    },


    // Round a price to the supported market precision

    round_price(market, price) {
        return this.round_num(price, market.precision.price);
    },


    // Round an order amount to the supported market precision

    round_amount(market, amount) {
        return this.round_num(amount, market.precision.amount);
    },


    // Get relative price

    get_relative_price(market, price) {
        var operator = String(price).substr(0,1);
        var market_price = (operator == '+' ? market.ask : market.bid);
        var original_price = price;
        price = price.replace(operator, '');
        if (String(price).indexOf('%') > 0) {   // Price is a percentage
            price = price.replace('%','');
            var variance = market_price * (price / 100);
        } else {                                // Price is a float
            var variance = price;
        }
        variance = (String(operator) + String(variance)) * 1;
        var relative_price = this.round_price(market, market_price + variance);
        this.output.debug('convert_rel_price', [original_price, relative_price]);
        return relative_price;
    },

    
    // Get USD size of current position from exchange

    async position_size_usd(symbol) {
        var filter = {symbol: symbol}
        var position = await this.exchange.position(filter);
        if (!this.utils.is_empty(position)) {
            return position['usd_size'];
        }
        return 0;  
    },

    // Get current position for symbol

    async get_position(symbol) {
        var filter = {symbol: symbol}
        var position = await this.exchange.position(filter);
        if (!this.utils.is_empty(position)) {
            return position;
        }
        return false;  
    },

    // Get relative numbers operator (+ or -)

    get_operator(num) {
        return ['+','-'].includes(String(num).substr(0,1)) ? String(num).substr(0,1) : undefined;
    },

    // Apply operator to number

    apply_operator(num) {
        if (this.is_relative(num)) {
            var operator = this.get_operator(num)
            num = (operator == '+' ? 1 : -1) * parseFloat(num.replace(operator, ''))
            return num
        }
        return num
    },

    // Get market price

    async get_market_price(symbol, side) {
        const market = await this.exchange.get_market_by_symbol(symbol);
        return (side == 'buy' ? market.ask : (side == 'sell' ? market.bid : market.avg));
    },

    
    // Convert base, quote or USD order size to order amount
    
    async get_amount(params, type = 'standard') {

        var [market, symbol, side, size, base, quote, usd, price, stopsize, stopbase, stopquote, stopusd, stoptrigger, stopprice, profitsize, profitbase, profitquote, profitusd, profittrigger, profitprice] = this.utils.extract_props(params, ['market', 'symbol', 'side', 'size', 'base', 'quote', 'usd', 'price', 'stopsize', 'stopbase', 'stopquote', 'stopusd', 'stoptrigger', 'stopprice', 'profitsize', 'profitbase', 'profitquote', 'profitusd', 'profittrigger', 'profitprice']);

        // Override sizing for stop loss and take profit orders
        switch(type) {
            case 'stoploss' :   size = (stopsize != undefined ? stopsize : size);
                                base = (stopbase != undefined ? stopbase : base);
                                quote = (stopquote != undefined ? stopquote : quote);
                                usd = (stopusd != undefined ? stopusd : usd);
                                price = (stopprice == undefined ? stoptrigger : stopprice);
                                break;
            case 'takeprofit' : size = (profitsize != undefined ? profitsize : size);
                                base = (profitbase != undefined ? profitbase : base);
                                quote = (profitquote != undefined ? profitquote : quote);
                                usd = (profitusd != undefined ? profitusd : usd);
                                price = (profitprice == undefined ? profittrigger : profitprice);
                                break;
        }

        if (size != undefined) quote = size;

        // Get market data for symbol
        if (market == undefined) {
            const market = await this.exchange.get_market_by_symbol(symbol);
        }

        // Base and quote prices
        var basesize  = (base  != undefined ? base  : null);
        var quotesize = (quote != undefined ? quote : null);

        // Get indicative market price and convert price if it is relative
        var market_price = await this.get_market_price(symbol, side);
        if (price == undefined) price = market_price;
        if (this.is_relative(price)) {
            price = await this.get_relative_price(market, price);
        }

        // Size provided in USD
        if (base == undefined && quote == undefined && usd != undefined) {
            if (this.stablecoins.includes(market.quote)) {
                this.output.debug('convert_size_usd')
                quotesize = usd;
            } else {
                var conversion_pairs = Object.values(market.usd.pairs).join(', ');
                this.output.debug('convert_size_pair', conversion_pairs)
                if (market.hasOwnProperty('usd')) {
                    basesize  = usd / market.usd.base;
                    quotesize = usd / market.usd.quote;
                } else {
                    this.output.error('convert_size_usd')
                }
            }
        }

        // Amount based on Exchange's order sizing (base or quote)
        var amount = null;
        switch (this.order_sizing) {
            case  'base'    :   amount = (basesize != null ? basesize : quotesize / price);
                                this.output.debug('exchange_size_base', market.base)
                                break;
            case  'quote'   :   amount = (quotesize != null ? quotesize : basesize * price);
                                this.output.debug('exchange_size_quote', market.quote)
                                break;
        }

        if (Number.isNaN(amount)) {            
            this.output.error('order_size_nan', this.utils.serialize({sizing: this.order_sizing, base: basesize, quote: quotesize, price: price}));
            return false;
        }

        return this.round_amount(market, amount);

    },

    
    // Get order parameters for layered pricing and sizing
    
    async order_params_advanced(type, params) {

        params = this.utils.lower_props(params);
        var [market, base, quote, usd, price, tag] = this.utils.extract_props(params, ['market', 'base', 'quote', 'usd', 'price', 'tag']);
        
        if (this.is_relative(price)) {
            var operator = this.get_operator(price);
            price = price.replace(operator, '');
        } else {
            var operator = undefined;
        }

        if (this.price_is_layered(price)) {
            var parts = String(price).replace('+','').replace('-','').split(',',3);
            if (parts.length == 2) {
                parts.push(5);          // Default quantity of orders in a layered order;
            }
            if (parts.length == 3) {
                var [val1, val2, qty] = parts;
            }
        } else {
            qty = 1;
            var val = price;
        }

        if (operator != undefined) {   // Convert relative prices into absolute prices
            if (qty == 1) {
                val = this.get_relative_price(market, operator + String(val));
            } else {
                val1 = this.get_relative_price(market, operator + String(val1));
                val2 = this.get_relative_price(market, operator + String(val2));
            }
        }

        if (qty == 1) {                 // Non-layered order
            var adv_params = params;
            adv_params.price = val;
            var order_params = await this.order_params_standard(type, adv_params);
            return order_params;
        } else {                        // Layered order
            var minprice = Math.min(val1, val2);
            var maxprice = Math.max(val1, val2);
            var variance = (maxprice - minprice) / (qty - 1);
            var order_params = [];
            for (var i = 0; i < qty; i++) {
                var adv_params   = params;
                adv_params.base  = (base != undefined ? base / qty : undefined);
                adv_params.quote = (quote != undefined ? quote / qty : undefined);
                adv_params.usd   = (usd != undefined ? usd / qty : undefined);
                adv_params.price = this.round_price(market, minprice + (variance * i));
                adv_params.tag   = tag != undefined ? tag + (qty > 1 ? '-' + (i + 1) : '') : undefined;
                var level_params = await this.order_params_standard(type, params);
                order_params.push(level_params);
            }
            this.output.debug('convert_layered', [qty, minprice, maxprice])
            return order_params;        
        }

    },

    // Check if sizing is a factor

    is_factor(size) {
        return (['x', '%'].includes(String(size).slice(-1))) ? true : false;
    },

    // Get factored size (size provided in x or %)

    async get_factored_size(order_type, params) {
        var [market, symbol, size] = this.utils.extract_props(params, ['market', 'symbol', 'size']);
        var size = String(size).toLowerCase();
        var operator = this.get_operator(size);
        if (operator == undefined)
            operator = '';
        var factor_type = String(size).slice(-1);
        switch (factor_type) {
            case 'x' : var factor = size.replace('x','').replace(operator, ''); break;
            case '%' : var factor = size.replace('%','').replace(operator, '') / 100; break;
            default  : var factor = 1; break;
        }
        var position_size = await this.position_size_usd(symbol);
        var balance_size = await this.exchange.total_balance_usd();
        if (order_type == 'close') {
            var base = Math.abs(position_size)
            operator = '';  // Ignore operator on close orders
        } else {
            var base = operator == '' ? Math.abs(balance_size) : Math.abs(position_size);  // If sizing is relative, make it relative to position size, else make it a factor of equity size
        }
        size = operator + String(this.round_num(base * factor, 0.05)); 
        return size
    },

    // Get relative size
    
    get_relative_size(current, size) {
        var operator = this.get_operator(size);
        return current + ((operator == '+' ? 1 : -1) * size.replace(operator, ''));
    },

    
    // Get target position size
    
    async convert_size(type, params) {

        var [market, symbol, size, base, quote, usd, maxsize] = this.utils.extract_props(params, ['market', 'symbol', 'size', 'base', 'quote', 'usd', 'maxsize']);
        var side = null;
        var is_close = false;   // Report is order will result in position closure
        var is_flip = false;    // Report is order will result in position flip

        // Check for base and quote factored sizing
        if (this.is_factor(base) || this.is_factor(quote)) {
            this.output.translate('error','factor_only_size')
            return false;
        }

        // size=xxx is the same as usd=xxx
        if (size != undefined) {
            if (this.is_factor(size)) {
                usd = await this.get_factored_size(type, params)
                this.output.debug('order_size_factor', [size, usd])
            } else {
                usd = size
            }
            size = undefined
        }

        // Determine what kind of sizing was supplied and get the amount
        var sizes = {
            base: base,
            quote: quote, 
            usd: usd,
        }
        for (const [sizing_type, value] of Object.entries(sizes)) {
            if (value != undefined) {
                var sizing = sizing_type
                var requested = value
                break;
            }
        }

        // Determine current position size
        this.initialize_exchange(params)  // For some reason I have to reinitialize the exchange here, I'll have to fix this
        var current_position = await this.get_position(symbol)
        if (current_position !== false) {
            var dir = current_position.direction
            var current = (dir == 'long' ? 1 : -1) * parseFloat(current_position[sizing + '_size'])
        } else {
            var dir = 'flat'
            var current = 0; 
        }
        
        // Convert relative size

        var order_is_relative = false
        if (this.is_relative(requested)) {
            if (['long', 'short'].includes(type)) {
                if (maxsize == undefined) {
                    return this.output.error('order_rel_req_max', type)
                }
                requested = (dir == 'short' ? -1 : 1) * (Math.abs(current) + this.apply_operator(requested))
                order_is_relative = true
            } else {
                return this.output.error('order_size_rel', type)
            }
        }

        var target = null
        requested = parseFloat(requested)   // Ensure requested is a float

        switch (type) {
            case 'buy'   :  target = current + requested;         break;
            case 'sell'  :  target = current - requested;         break;
            case 'long'  :  target = requested;                   break;
            case 'short' :  target = -1 * Math.abs(requested);    break;
            case 'close' :  if (dir == 'flat') return this.output.error('position_none', symbol)
                            target = (dir == 'long') ? current - requested : current + requested
                            is_close = true
        }

        // Maxsize checks
        if (maxsize != undefined) {

            if (['short', 'sell'].includes(type)) {     // Make sure maxsize is negative for sell orders
                maxsize = -1 * Math.abs(maxsize)
            }

            // Check if long or short order would exceed maxsize
            if (order_is_relative && ((type == 'long' && target > maxsize) || (type == 'short' && target < maxsize))) {
                target = maxsize;
                var newsize = Math.abs(target) - Math.abs(current)
                if (newsize < 0)
                    return this.output.error('order_over_maxsize', requested)
                else
                    this.output.warning('order_over_maxsize', [requested, newsize])            
            }
            // Check if buy or sell order would exceed maxsize
            if ((type == 'buy' && target > maxsize) || (type == 'sell' && target < maxsize)) {
                target = maxsize;
                var newsize = Math.abs(target) - Math.abs(current)
                if (newsize < 0)
                    return this.output.error('order_over_maxsize', requested)
                else
                    this.output.warning('order_over_maxsize', [requested, newsize])            
            }
        }

        // Check if already long or short more than requested (non relative orders only)
        if (!order_is_relative && ((type == 'long' && target < current) || (type == 'short' && target > current))) {
            return this.output.error('order_size_exceeds', type)  
        }

        // Check if long or short relative order would cause a flip and prevent it
        if (order_is_relative && ((type == 'long' && target < 0) || (type == 'short' && target > 0))) {
            this.output.warning('order_rel_close')
            is_close = true
            target = 0
        }

        // Check for a position flip 
        if ((dir == 'long' && target < 0) || (dir == 'short' && target > 0)) {
            is_flip = true
            this.output.warning('order_will_flip', [dir, (dir == 'long' ? 'short' : 'long')])
        }

        // Check if close order would exceed current position size
        if (type == 'close' && ((target > 0 && current < 0) || (target < 0 && current > 0))) {
            this.output.warning('close_exceeds_pos', [requested, 0 - current])
            target = 0;
        }

        var order_size = target - current
        var order_side = (order_size >= 0 ? 'buy' : 'sell')

        var currencies = {
            base:  market.base,
            quote: market.quote,
            usd:   'USD',
        }
        var currency = currencies[sizing];

        this.output.debug('order_sizing_type', [currency, (sizing == 'usd' ? 'USD' : sizing)])
        this.output.debug('order_sizing_cur', [ (sizing == 'usd' ? 'USD' : sizing), currency, current])
        this.output.debug('order_sizing_tar', [ (sizing == 'usd' ? 'USD' : sizing), currency, target])
        this.output.debug('order_sizing_ord', [this.utils.uc_first(order_side), currency, order_size])

        // Return result
        return [sizing, order_size, order_side, {is_close : is_close, is_flip: is_flip}];
        
    },

    // Generate order parameters for standard orders (market, limit)
    
    async order_params_standard(type, params) {

        // Calculate order sizing and direction (side)
        let order_sizes = await this.convert_size(type, params);   

        if (order_sizes === false)
            return this.output.error('order_size_unknown');
        
        var [sizing, size, side, flags] = order_sizes;
        params[sizing] = size;
        params.side = side;

        // Extract params
        params = this.utils.lower_props(params);
        var [symbol, side, price, post, ioc, tag] = this.utils.extract_props(params, ['symbol', 'side', 'price', 'post', 'ioc', 'tag']);
        
        // Get parameters from the normalizer
        this.param_map = this.exchange.get('param_map');
        this.order_sizing = this.exchange.get('order_sizing');
        this.stablecoins = this.exchange.get('stablecoins');

        //Check if an order is an advanced order (layered orders, relative pricing, etc)
        if (this.order_is_advanced(price)) {
            var level_params = await this.order_params_advanced(type, params);
            return level_params;
        }

        // Base order params object
        var order_params = {
            symbol  :   symbol.toUpperCase(),
            type    :   this.param_map[(price == undefined ? 'market' : 'limit')],
            side    :   side,
            amount  :   await this.get_amount(params),
            price   :   (price != undefined ? price : null),
            params  :   {}
        }
        
        // Add additional parameters
        order_params.params[this.param_map.post]   = (String(post)   == "true" ? true : undefined);
        order_params.params[this.param_map.ioc]    = (String(ioc)    == "true" ? true : undefined);
        order_params.params[this.param_map.tag]    = tag;

        return this.utils.remove_props(order_params, [null, undefined]);

    },

    
    // Generate paramaters for conditional orders (stop loss or take profit)
    
    async order_params_conditional(type, params) {

        params = this.utils.lower_props(params);

        switch (type) {
            case 'stoploss' :   var [symbol, side, trigger, price, reduce, tag] = this.utils.extract_props(params, ['symbol', 'side', 'stoptrigger', 'stopprice', 'reduce', 'tag']);
                                var above = 'buy';
                                var below = 'sell';
                                side = undefined;
                                break;
            case 'takeprofit' : var [symbol, side, trigger, price, reduce, tag] = this.utils.extract_props(params, ['symbol', 'side', 'profittrigger', 'profitprice', 'reduce', 'tag']);
                                var above = 'sell';
                                var below = 'buy';
                                side = undefined;
                                break;
        }
        
        // Get parameters from the normalizer
        this.param_map = this.exchange.get('param_map');
        this.order_sizing = this.exchange.get('order_sizing');
        this.stablecoins = this.exchange.get('stablecoins');

        // Get marker info
        const market = await this.exchange.get_market_by_symbol(symbol);

        //Check if stoptrigger or stopprice is relative and convert if necessary
        if (this.is_relative(trigger)) {
            trigger = this.get_relative_price(market, trigger);
        }
        if ((price != undefined) && (this.is_relative(price))) {
            price = this.get_relative_price(market, price);
        }

        // If side is undefined, assume side based on trigger above or below market price
        if (side == undefined) {
            var market_price = await this.get_market_price(symbol);
            side = (trigger > market_price ? above : (trigger < market_price ? below : null));
            if (side == null) {
                return this.output.error('order_side_unknown');
            } else {
                this.output.debug('order_side_assumed', side);
            }
        }

        // Base order params object
        var order_params = {
            symbol  :   symbol.toUpperCase(),
            type    :   this.param_map[(price == undefined ? type + '_market' : type + '_limit')],
            side    :   side.toLowerCase(),
            amount  :   await this.get_amount(params, type),
            price   :   (price != undefined ? price : null),
            params  :   {}
        }
        
        // Add additional parameters
        order_params.params[this.param_map.reduce] = (String(reduce) == "true" ? true : undefined);
        order_params.params[this.param_map.trigger] = trigger;
        //order_params.params[this.param_map.tag]    = tag;
        
        return this.utils.remove_props(order_params, [null, undefined]);

    },


    // Parse params and create an order

    async create_order(type, params) {
        this.initialize_exchange(params);
        params.market = await this.exchange.get_market_by_symbol(params.symbol.toUpperCase());
        this.output.subsection('order_' + type);  
        var order_params = null;
        switch (type) {
            case 'long'        : order_params = await this.order_params_standard('long', params);
                                 break;
            case 'short'       : order_params = await this.order_params_standard('short', params);
                                 break;
            case 'buy'         : order_params = await this.order_params_standard('buy', params);
                                 break;
            case 'sell'        : order_params = await this.order_params_standard('sell', params);
                                 break;
            case 'close'       : order_params = await this.order_params_standard('close', params);
                                 break;
            case 'stoploss'    : order_params = await this.order_params_conditional('stoploss', params);
                                 break;
            case 'takeprofit'  : order_params = await this.order_params_conditional('takeprofit', params);
                                 break;
            case 'trailstop'   : order_params = await this.order_params_conditional('trailstop', params);
                                 break;
        }    
        if (order_params !== false)
            this.queue_order(order_params);

        // Order includes a stoploss or takeprofit component (long and short orders only)
        if (['long', 'short'].includes(type)) {
            if (params.stoptrigger != undefined) {
                await this.create_order('stoploss', params);
            }
            if (params.profittrigger != undefined) {
                await this.create_order('takeprofit', params);
            }    
        }
    },


    // Add orders to the order queue
    
    queue_order(params) {
        if (this.order_queue == undefined) {
            this.order_queue = [];
        }
        if (!this.utils.is_array(params)) {
            params = [params];
        }
        params.forEach(order => {
            this.output.notice('order_queued', this.utils.serialize(order));
            this.order_queue.push(order);
        });
    },

    
    // Clear order queue
    
    clear_order_queue() {
        this.order_queue = [];
    },
    
    
    // Process order queue (submit orders to the exchange)

    async process_order_queue() {
        this.order_results = [];
        var total_orders = this.order_queue.length;
        var success_orders = 0;
        this.output.subsection('processing_queue', total_orders);
        this.output.notice('processing_queue', total_orders); 
        //output.set_exitcode(0);
        for (const order of this.order_queue) {
            let result = await this.submit_order(order);
            if (result.result == 'success') {
                success_orders++;
                this.output.success('order_submit', this.utils.serialize(order)); 
            } else {
                //output.set_exitcode(-1);
                var message = result.error.type + ': ' + result.error.message;
                var params = this.utils.serialize(result.params);
                var info = message + ': ' + params;
                this.output.error('order_submit', [info, this.utils.serialize(order)]); 
            }
            this.order_results.push(result);
        };
        this.clear_order_queue();
        var results = this.order_results;
        this.output.notice('processed_queue', [success_orders, total_orders]);   
        this.order_results = [];
        if (success_orders == 0) {
            return false;
        }
        return results;
    },


    // Submit order to the exchange

    async submit_order(params) {
        var result = await this.exchange.create_order(params);
        return result;
    },    


    // Clear order queue, create orders, and process the queue (submit orders to the exchange)

    async create_and_submit_order(type, params) {
        this.clear_order_queue();
        await this.create_order(type, params);
        return await this.process_order_queue();
    },


    // ------------------------------------------------------------------------------------------- //
    // ------------------ The method below are used by modules/mod.trade.js ---------------------- //
    // ------------------------------------------------------------------------------------------- //


    // Long Order

    async long(params) {
        this.initialize_exchange(params);
        return await this.create_and_submit_order('long', params);
    },

    // Short Order

    async short(params) {
        this.initialize_exchange(params);
        return await this.create_and_submit_order('short', params);
    },


    // Buy Order

    async buy(params) {
        this.initialize_exchange(params);
        return await this.create_and_submit_order('buy', params);
    },


    // Sell Order

    async sell(params) {
        this.initialize_exchange(params);
        return await this.create_and_submit_order('sell', params);
    },


    // Stoploss Order

    async stoploss(params) {
        this.initialize_exchange(params);
        return await this.create_and_submit_order('stoploss', params);
    },


    // Takeprofit Order

    async takeprofit(params) {
        this.initialize_exchange(params);
        return await this.create_and_submit_order('takeprofit', params);
    },


    // Trailstop Order

    async trailstop(params) {
        this.initialize_exchange(params);
        return await this.create_and_submit_order('trailstop', params);
    },


    // Close Order

    async close(params) {
        this.initialize_exchange(params);
        return await this.create_and_submit_order('close', params);
    },


    // Get list of orders
    
    async orders(params) {
        this.initialize_exchange(params);
        let result = await this.exchange.orders(params);
        if (this.utils.is_array(result)) {
            this.output.success('orders_retrieve', result.length)
            return result;        
        } else {
            this.output.error('orders_retrieve')
            return false;
        }
    },

    
    // Cancel orders
    
    async cancel(params) {
        this.initialize_exchange(params);
        let result = await this.exchange.cancel(params);
        if (this.utils.is_array(result) && result.length == 1) {
            this.output.success('order_cancel', params.id)
        } else {
            this.output.error('order_cancel', params.id)
        }
        return result;
    },


    // Cancel all orders
    
    async cancelall(params) {
        this.initialize_exchange(params);
        let result = await this.exchange.cancel_all(params);
        if (this.utils.is_array(result)) {
            this.output.success('orders_cancel', result.length)
        } else {
            this.output.error('orders_cancel')
        }
        return result;
    },    

    // Get position
    
    async position(params) {
        this.initialize_exchange(params);
        var result = await this.exchange.position(params);
        if (!this.utils.is_array(result)) {
            this.output.success('position_retrieve', result.symbol)
        } else {
            this.output.error('position_retrieve', params.symbol)
        }
        return result;
    },
    
    // Get positions
    
    async positions(params) {
        this.initialize_exchange(params);
        var result = await this.exchange.positions(params);
        if (this.utils.is_array(result)) {
            this.output.success('positions_retrieve', result.length)
        } else {
            this.output.error('positions_retrieve')
        }
        return result;
    },

    // Get balances
    
    async balances(params) {
        this.initialize_exchange(params);
        var result = await this.exchange.balances(params);
        if (this.utils.is_array(result)) {
            this.output.success('balances_retrieve', result.length)
        } else {
            this.output.error('balances_retrieve')
        }
        return result;
    },    
    
    // Get market
    
    async market(params) {
        this.initialize_exchange(params);
        var result = await this.exchange.market(params);
        if (!this.utils.is_array(result)) {
            this.output.success('market_retrieve', result.symbol)
        } else {
            this.output.error('market_retrieve', params.symbol)
        }
        return result;        
    },


    // Get markets
    
    async markets(params) {
        this.initialize_exchange(params);
        var result = await this.exchange.markets(params);
        if (this.utils.is_array(result)) {
            this.output.success('markets_retrieve', result.length)
        } else {
            this.output.error('markets_retrieve')
        }
        return result;
    },    

}
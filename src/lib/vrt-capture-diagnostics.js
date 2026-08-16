export default `
    return (function () {
        var de = document.documentElement || {};
        var body = document.body || {};
        var style = de.currentStyle || {};
        if (!de.currentStyle && window.getComputedStyle) {
            style = window.getComputedStyle(de, null) || {};
        }
        var clientWidth = de.clientWidth || body.clientWidth || 0;
        var clientHeight = de.clientHeight || body.clientHeight || 0;
        var documentScrollWidth = de.scrollWidth || 0;
        var documentScrollHeight = de.scrollHeight || 0;
        var bodyScrollWidth = body.scrollWidth || 0;
        var bodyScrollHeight = body.scrollHeight || 0;
        var deviceXDPI = window.screen && screen.deviceXDPI ? screen.deviceXDPI : null;
        var logicalXDPI = window.screen && screen.logicalXDPI ? screen.logicalXDPI : null;
        return {
            documentMode: document.documentMode || null,
            viewport: {
                width: clientWidth,
                height: clientHeight,
                innerWidth: typeof window.innerWidth === 'number' ? window.innerWidth : null,
                innerHeight: typeof window.innerHeight === 'number' ? window.innerHeight : null
            },
            document: {
                clientWidth: de.clientWidth || 0,
                clientHeight: de.clientHeight || 0,
                scrollWidth: documentScrollWidth,
                scrollHeight: documentScrollHeight
            },
            body: {
                clientWidth: body.clientWidth || 0,
                clientHeight: body.clientHeight || 0,
                scrollWidth: bodyScrollWidth,
                scrollHeight: bodyScrollHeight
            },
            overflow: {
                x: style.overflowX || style.overflow || '',
                y: style.overflowY || style.overflow || '',
                vertical: Math.max(documentScrollHeight, bodyScrollHeight) > clientHeight,
                horizontal: Math.max(documentScrollWidth, bodyScrollWidth) > clientWidth
            },
            direction: style.direction || de.dir || body.dir || 'ltr',
            scroll: {
                x: window.pageXOffset || de.scrollLeft || body.scrollLeft || 0,
                y: window.pageYOffset || de.scrollTop || body.scrollTop || 0
            },
            display: {
                deviceXDPI: deviceXDPI,
                logicalXDPI: logicalXDPI,
                zoomPercent: deviceXDPI && logicalXDPI ? Math.round(deviceXDPI * 100 / logicalXDPI) : null,
                devicePixelRatio: typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : null
            }
        };
    }());
`;

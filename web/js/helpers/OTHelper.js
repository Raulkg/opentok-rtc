!function(global) {
  'use strict';

  var otPromise = Promise.resolve();
  var annotation;

  otPromise = LazyLoader.load([opentokJsUrl]);

  var MSG_MULTIPART = 'signal';
  var SIZE_MAX = 7800;

  var HEAD_SIZE =
        JSON.stringify({ _head: { id: 99, seq: 99, tot: 99}, data: "" }).length;
  var USER_DATA_SIZE = SIZE_MAX - HEAD_SIZE;
  var logger =
        new Utils.MultiLevelLogger('OTHelper.js', Utils.MultiLevelLogger.DEFAULT_LEVELS.all);

  var requestedResolutions = {};
  var otLoaded = otPromise.then(function() {
    var hasRequirements = OT.checkSystemRequirements();
    if (!hasRequirements) {
      OT.upgradeSystemRequirements();
      throw new Error('Unsupported browser, probably needs upgrade');
    }
    return;
  });

  // Done intentionally (to use string codes for our error codes)
  // so as to not overwrite existing OT library codes
  var PUB_SCREEN_ERROR_CODES = {
    accessDenied: 1500,
    extNotInstalled: 'OT0001',
    extNotRegistered: 'OT0002',
    notSupported: 'OT0003',
    errPublishingScreen: 'OT0004'
  };

  function getScreenShareCapability() {
    return new Promise(function(resolve, reject) {
      OT.checkScreenSharingCapability(function(response) {
        if (!response.supported) {
          reject({
            code: PUB_SCREEN_ERROR_CODES.notSupport,
            message: 'This browser does not support screen sharing.'
          });
        } else if (response.extensionRegistered === false) {
          reject({
            code: PUB_SCREEN_ERROR_CODES.extNotRegistered,
            message: 'This browser does not support screen sharing.'
          });
        } else if (response.extensionRequired !== undefined &&
                   response.extensionInstalled === false) {
          reject({
            code: PUB_SCREEN_ERROR_CODES.extNotInstalled,
            message: 'Please install the screen sharing extension and load your app over https.'
          });
        } else {
          resolve();
        }
      });
    });
  }

  function registerScreenShareExtension(aParams, version) {
    Object.keys(aParams).forEach(function(aKey) {
      OT.registerScreenSharingExtension(aKey, aParams[aKey], version || 2);
    });
  }

  var sendSignal = (function() {
    var messageOrder = 0;
    function composeSegment(aMsgId, aSegmentOrder, aTotalSegments, aUsrMsg) {
      var obj = {
        type: aUsrMsg.type,
        data: JSON.stringify({
          _head: {
            id: aMsgId,
            seq: aSegmentOrder,
            tot: aTotalSegments
          },
          data: aUsrMsg.data ?
            aUsrMsg.data.substr(aSegmentOrder * USER_DATA_SIZE, USER_DATA_SIZE) :
            ''
        })
      };
      if (aUsrMsg.to) {
        obj.to = aUsrMsg.to;
      }
      return obj;
    }

    //
    // Multipart message sending proccess. this is expected to be the actual session
    //
    var sendSignal = function(aType, aMsgData, aTo) {
      var session = this;
      return new Promise(function(resolve, reject) {
        var msg = {
          type: aType,
          data: aMsgData && JSON.stringify(aMsgData)
        };
        var msgId = ++messageOrder;
        var totalSegments = msg.data ? Math.ceil(msg.data.length / USER_DATA_SIZE) : 1;
        var messagesSent = [];
        for (var segmentOrder = 0; segmentOrder < totalSegments; segmentOrder++) {
          var signalData = composeSegment(msgId, segmentOrder, totalSegments, msg);
          if (aTo) {
            signalData.to = aTo;
          }
          messagesSent[segmentOrder] =
            new Promise(function(resolveMessage, rejectMessage) {
              session.signal(signalData, function(error) {
                (error && (rejectMessage(error) || true)) || resolveMessage();
              });
            });
        }
        Promise.all(messagesSent).then(resolve).catch(reject);
      });
    };
    return sendSignal;
  })();

  var receiveMultipartMsg = (function() {
    var _msgPieces = {};

    //
    // Multipart message reception proccess
    //
    function parseMultiPartMsg(aEvt) {
      var dataParsed;
      dataParsed = JSON.parse(aEvt.data);
      var fromConnectionId = aEvt.from !== null ? aEvt.from.connectionId : 'server';
      return {
        connectionId: fromConnectionId,
        head: dataParsed._head,
        data: dataParsed.data
      };
    }

    var receiveMultipartMsg = function(aFcClients, aEvt) {
      var parsedMsg = parseMultiPartMsg(aEvt);

      var connection = _msgPieces[parsedMsg.connectionId];
      var newPromise = null;
      // First msg from a client
      if (!connection) {
        connection = {};
        _msgPieces[parsedMsg.connectionId] = connection;
      }

      var msg = connection[parsedMsg.head.id];

      // First piece of a message
      if (!msg) {
        msg = {
          have: 0,
          data: new Array(parsedMsg.head.tot),
          promiseSolver: null
        };
        // Get a new solver
        newPromise = new Promise(function (resolve, reject) {
          msg.promiseSolver = resolve;
        });
        aFcClients.forEach(function(aFc) {
          newPromise.then(aFc);
        });
        connection[parsedMsg.head.id] = msg;
      }
      // This shouldn't be needed since we can only set one handler per signal
      // now, but doesn't hurt
      if (!msg.data[parsedMsg.head.seq]) {
        msg.data[parsedMsg.head.seq] = parsedMsg.data;
        msg.have++;
      }

      if (parsedMsg.connectionId === 'server') {
        msg.promiseSolver(parsedMsg.data);
      }

      // If we have completed the message, fulfill the promise
      if (msg.have >= parsedMsg.head.tot ) {
        aEvt.data = msg.data.join('');
        msg.promiseSolver(aEvt);
        delete connection[parsedMsg.head.id];
      }
    };

    return receiveMultipartMsg;

    // END Reception multipart message proccess
  })();

  // We need to intercept the messages which type is multipart and wait until
  // the message is complete before to send it (launch client event)
  // aHandlers is an array of objects
  function _setHandlers(aBindTo, aReceiver, aHandlers) {
    var _interceptedHandlers = {};

    // First add the handlers removing the ones we want to intercept...
    for(var i = 0; i < aHandlers.length; i++) {
      var _handlers = {};
      Object.
        keys(aHandlers[i]).
        forEach(function(evtName) {
          var handler = aHandlers[i][evtName];
          if (evtName.startsWith(MSG_MULTIPART)) {
            _interceptedHandlers[evtName] = _interceptedHandlers[evtName] || [];
            _interceptedHandlers[evtName].push(handler.bind(aBindTo));
          } else {
            _handlers[evtName] = handler.bind(aBindTo);
          }
        });
      aReceiver.on(_handlers);
    }

    // And then add the intercepted handlers
    Object.
      keys(_interceptedHandlers).
      forEach(function(evtName) {
        _interceptedHandlers[evtName] =
          receiveMultipartMsg.bind(undefined, _interceptedHandlers[evtName]);
      });
    aReceiver.on(_interceptedHandlers);
  }

  // aSessionInfo must have sessionId, apiKey, token
  function OTHelper() {
    var _session;
    var _publisher;
    var _publisherInitialized = false;

    function disconnect() {
      if (_session) {
        _session.disconnect();
      }
    }

    function off() {
      _session && _session.off();
    }

    // aHandlers is either an object with the handlers for each event type
    // or an array of objects
    function connect(sessionInfo, aHandlers) {
      var self = this;
      var apiKey = sessionInfo.apiKey;
      var sessionId = sessionInfo.sessionId;
      var token = sessionInfo.token;
      if (!Array.isArray(aHandlers)) {
        aHandlers = [aHandlers];
      }
      return otLoaded.then(function() {
        return new Promise(function(resolve, reject) {
          if (!(apiKey && sessionId && token)) {
            return reject({
              message: 'Invalid parameters received. ' +
                'ApiKey, sessionId and Token are mandatory'
            });
          }
          disconnect();
          _session = OT.initSession(apiKey, sessionId);
          _session.off();

          aHandlers && _setHandlers(self, self.session, aHandlers);

          return _session.connect(token, function(error) {
            if (error) {
              reject(error);
            } else {
              self.sendSignal = sendSignal.bind(_session);
              resolve(_session);
            }
          });
        });
      });
    };

    function removeListener(evtName) {
      _session.off(evtName);
    }

    var _publishOptions;
    // We will use this in case the first publish fails. On the error we will give the caller a
    // promise that will fulfill when/if the publish succeeds at some future time (because of a
    // retry).
    var _solvePublisherPromise;
    var _publisherPromise = new Promise(function(resolve, reject) {
      _solvePublisherPromise = resolve;
    });

    function initPublisher(aDOMElement, aProperties, aHandlers) {
      return new Promise(function(resolve, reject) {
        otLoaded.then(function() {
          getFilteredSources({
            audioSource: aProperties.audioSource,
            videoSource: aProperties.videoSource
          }).then(function(mediaSources) {
            Object.assign(aProperties, mediaSources);
            _publisher = OT.initPublisher(aDOMElement, aProperties);
            return resolve(_publisher);
          });
          
        });
      });
    }

 var Filters = {
    none: function none(imgData) {
      return imgData;
    },

    grayscale: function grayscale(imgData) {
      const res = new Uint8ClampedArray(imgData.data.length);
      for (let i = 0; i < imgData.data.length; i += 4) {
        // Using the luminosity algorithm for grayscale 0.21 R + 0.72 G + 0.07 B
        // https://www.johndcook.com/blog/2009/08/24/algorithms-convert-color-grayscale/
        var inputRed = imgData.data[i];
        var inputGreen = imgData.data[i + 1];
        var inputBlue = imgData.data[i + 2];
        res[i] = res[i + 1] = res[i + 2] = Math.round(0.21 * inputRed + 0.72 * inputGreen + 0.07 * inputBlue);
        res[i + 3] = imgData.data[i + 3];
      }
      return new ImageData(res, imgData.width, imgData.height);
    },

    sepia: function sepia(imgData) {
      const res = new Uint8ClampedArray(imgData.data.length);
      for (let i = 0; i < imgData.data.length; i += 4) {
        // Using the algorithm for sepia from:
        // https://www.techrepublic.com/blog/how-do-i/how-do-i-convert-images-to-grayscale-and-sepia-tone-using-c/
        var inputRed = imgData.data[i];
        var inputGreen = imgData.data[i + 1];
        var inputBlue = imgData.data[i + 2];
        res[i] = Math.round((inputRed * 0.393) + (inputGreen * 0.769) + (inputBlue * 0.189));
        res[i + 1] = Math.round((inputRed * 0.349) + (inputGreen * 0.686) + (inputBlue * 0.168));
        res[i + 2] = Math.round((inputRed * 0.272) + (inputGreen * 0.534) + (inputBlue * 0.131));
        res[i + 3] = imgData.data[i + 3];
      }
      return new ImageData(res, imgData.width, imgData.height);
    },

    invert: function invert(imgData) {
      const res = new Uint8ClampedArray(imgData.data.length);
      for (let i = 0; i < imgData.data.length; i += 4) {
        // Invert the colors red = 255 - inputRed etc.
        res[i] = 255 - imgData.data[i];
        res[i + 1] = 255 - imgData.data[i + 1];
        res[i + 2] = 255 - imgData.data[i + 2];
        res[i + 3] = imgData.data[i + 3]; // Leave alpha alone
      }
      return new ImageData(res, imgData.width, imgData.height);
    }
  };

  Filters.selectedFilter = Filters.none;

      var getFilteredCanvas = function getFilteredCanvas(mediaStream) {
        var WIDTH = 640;
        var HEIGHT = 480;
        var videoEl = document.createElement('video');
        videoEl.srcObject = mediaStream;
        videoEl.setAttribute('playsinline', '');
        videoEl.muted = true;
        setTimeout(function timeout() {
          videoEl.play();
        });
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');
        canvas.width = WIDTH;
        canvas.height = HEIGHT;

        var tmpCanvas = document.createElement('canvas');
        var tmpCtx = tmpCanvas.getContext('2d');
        tmpCanvas.width = WIDTH;
        tmpCanvas.height = HEIGHT;

        videoEl.addEventListener('resize', function resize() {
          canvas.width = tmpCanvas.width = videoEl.videoWidth;
          canvas.height = tmpCanvas.height = videoEl.videoHeight;
        });

        var reqId;

        // Draw each frame of the video
        var drawFrame = function drawFrame() {
          // Draw the video element onto the temporary canvas and pull out the image data
          tmpCtx.drawImage(videoEl, 0, 0, tmpCanvas.width, tmpCanvas.height);
          var imgData = tmpCtx.getImageData(0, 0, tmpCanvas.width, tmpCanvas.height);
          // Apply the currently selected filter and get the new image data
          imgData = Filters.selectedFilter(imgData);
          // Draw the filtered image data onto the main canvas
          ctx.putImageData(imgData, 0, 0);

          reqId = requestAnimationFrame(drawFrame);
        };

        reqId = requestAnimationFrame(drawFrame);

        return {
          canvas: canvas,
          stop: function stop() {
            // Stop the video element, the media stream and the animation frame loop
            videoEl.pause();
            if (mediaStream.stop) {
              mediaStream.stop();
            }
            if (MediaStreamTrack && MediaStreamTrack.prototype.stop) {
              // Newer spec
              mediaStream.getTracks().forEach(function each(track) { track.stop(); });
            }
            cancelAnimationFrame(reqId);
          }
        };
      };

    function publish(aDOMElement, aProperties, aHandlers) {
      var self = this;
      _publishOptions = null;
      var propCopy = {};
      Object.keys(aProperties).forEach(function(aKey) {
        propCopy[aKey] = aProperties[aKey];
      });
      return new Promise(function(resolve, reject) {
        function processError(error) {
          _publishOptions = {
            elem: aDOMElement,
            properties: propCopy,
            handlers: aHandlers
          };
          _publisher = null;
          reject({ error: error, publisherPromise: _publisherPromise });
        }
             OT.getUserMedia().then(function gotMedia(mediaStream) {
             var filteredCanvas = getFilteredCanvas(mediaStream);
             aProperties.videoSource = filteredCanvas.canvas.captureStream(30).getVideoTracks()[0];

        _publisher = OT.initPublisher(aDOMElement, aProperties, function(error) {
          if (error) {
            processError({
              name: error.name,
              message: 'Error initializing publisher. ' + error.message
            });
           return;
          }

          _session.publish(_publisher, function(error) {
            if (error) {
              processError(error);
            } else {
              _publisherInitialized = true;
              Object.keys(aHandlers).forEach(function(name) {
                _publisher.on(name, aHandlers[name].bind(self));
              });

              _solvePublisherPromise(_publisher);
              resolve(_publisher);
            }
          });
        });

               })
      });
    }

    function subscribeTo(aStream, name, value) {
      var arrSubscribers = _session.getSubscribersForStream(aStream);
      // TODO Currently we expect only one element in arrSubscriber
      Array.isArray(arrSubscribers) && arrSubscribers.forEach(function(subscriber) {
        subscriber['subscribeTo' + name](value);
      });
    }

    function retryPublish() {
      return publish(_publishOptions.elem, _publishOptions.properties, _publishOptions.handlers);
    }

    function publisherReady() {
      return _publisher && _publisherPromise ||
        _publishOptions && retryPublish() ||
        Promise.reject();
    }

    function togglePublisherProperty(aProperty, aValue) {
      publisherReady().then(function(aPublisher) {
        aPublisher['publish' + aProperty](aValue);
      });
    }

    function togglePublisherVideo(aValue) {
      return togglePublisherProperty('Video', aValue);
    }

    function togglePublisherAudio(aValue) {
      return togglePublisherProperty('Audio', aValue);
    }

    function toggleSubscribersVideo(aStream, value) {
      subscribeTo(aStream, 'Video', value);
    }

    function toggleSubscribersAudio(aStream, value) {
      subscribeTo(aStream, 'Audio', value);
    }

    function toggleFacingMode() {
      return _publisher.cycleVideo();
    }

    function setAudioSource(deviceId) {
      _publisher.setAudioSource(deviceId)
    }

    function toggleFilters() {
       var pos;
       var len = Object.keys(Filters).length;
       if(window.localStorage.getItem('currentFilterId') !=  null) {

       pos =  window.localStorage.getItem('currentFilterId');
        window.localStorage.setItem('currentFilterId', ++pos % (len-1));
       } else {

       window.localStorage.setItem('currentFilterId', 0);
       pos = 0;
       }

       Filters.selectedFilter = Filters[Object.keys(Filters)[pos]];
    }

    var _screenShare;

    const FAKE_OTK_ANALYTICS = global.OTKAnalytics ||
      function() { return {
          addSessionInfo: function() {},
          logEvent: function(a,b) {
            console.log(a,b);
          }
          };
      };

    // TO-DO: Make this configurable
    const IMAGE_ASSETS = '/images/annotations/';
    const TOOLBAR_BG_COLOR = '#1a99ce';

    function getAnnotation(aDomElement, aOptions) {
      aOptions = aOptions || {};
      var options = {
        session: aOptions.session || _session,
        watchForResize: aOptions.watchForResize || window,
        canvasContainer: aDomElement,
        OTKAnalytics: aOptions.OTKAnalytics || FAKE_OTK_ANALYTICS,
        imageAssets: IMAGE_ASSETS
      };
      return new AnnotationAccPack(options);
    }
    function resizeAnnotationCanvas () {
      annotation && annotation.resizeCanvas();
    }

    function startAnnotation(aAccPack) {
      if (!aAccPack) {
        return Promise.resolve();
      }
      annotation = aAccPack;
      Utils.addEventsHandlers('roomView:', {
        screenChange: resizeAnnotationCanvas
      });
      return aAccPack.start(_session, {
        imageAssets: IMAGE_ASSETS,
        backgroundColor: TOOLBAR_BG_COLOR
      });
    }

    // aElement can be a publisher, a subscriber or a AnnotationPack
    function endAnnotation(aElement) {
      var annPack =  aElement && aElement._ANNOTATION_PACK || aElement;
      annPack && annPack.end && annPack.end();
      Utils.removeEventHandlers('roomView:', {
        screenChange: resizeAnnotationCanvas
      });
      annotation = null;
    }

    function setupAnnotation(aAccPack, aPubSub, aParentElement) {
      if (!aAccPack) {
        return;
      }
      var container = document.getElementById(aPubSub.id);
      var canvasOptions = {
        absoluteParent: aParentElement
      };
      aAccPack.linkCanvas(aPubSub, container, canvasOptions);
      aPubSub._ANNOTATION_PACK = aAccPack;
    }

    function getDevices(kind = 'all') {
      return new Promise(function(resolve, reject) {
        OT.getDevices(function (error, devices) {
          if (error) return reject(error);
          devices = devices.filter(function (device) { return device.kind === kind || kind === 'all' });
          return resolve(devices);
        });
      });  
    }

    function getVideoDeviceNotInUse(selectedDeviceId) {
      return new Promise(function(resolve, reject) {
        getDevices('videoInput').then(function(videoDevices) {
          var matchingDevice = videoDevices.find(function(device) {
            return device.deviceId !== selectedDeviceId;
          });

          return resolve(matchingDevice || selectedDeviceId);
        });
      });
    }

    function getFallbackMediaDeviceId(devices, kind) {
      kind = kind.replace('Source', 'Input');
      var matchingDevice = devices.find(function(device) {
        return device.kind === kind;
      });  
      return matchingDevice ? matchingDevice.deviceId : null;
    }

    function getFilteredSources(mediaDeviceIds) {
      return new Promise(function(resolve, reject) {
        getDevices().then(function (devices) {          
          for (var source in mediaDeviceIds) {
            var matchingDevice = devices.find(function(device) {
              return device.deviceId === mediaDeviceIds[source];
            });

            if (!matchingDevice) mediaDeviceIds[source] = getFallbackMediaDeviceId(devices, source);
          }
          return resolve(mediaDeviceIds);
      }).catch(function(e) {
        return reject(e);
      });
    })
   }  

    function subscribe(aStream, aTargetElement, aProperties, aHandlers, aEnableAnnotation) {
      var self = this;
      return new Promise(function(resolve, reject) {
        var subscriber =
          _session.subscribe(aStream, aTargetElement, aProperties, function(error) {
            error ? reject(error) : resolve(subscriber);
          });
      }).then(function(subscriber) {
        Object.keys(aHandlers).forEach(function(name) {
          subscriber.on(name, aHandlers[name].bind(self));
        });
        subscriber.on('destroyed', function(evt) {
          subscriber.off();
          endAnnotation(subscriber);
        });
        var subsAnnotation =
          (aEnableAnnotation && aStream.videoType === 'screen' && getAnnotation(aTargetElement)) ||
          null;
        return startAnnotation(subsAnnotation).then(function() {
          setupAnnotation(subsAnnotation, subscriber,
                          document.querySelector('.opentok-stream-container'));
          return subscriber;
        });
      });;
    }

    function stopShareScreen() {
      // Should I return something like true/false or deleted element?
      endAnnotation(_screenShare);
      _screenShare && _session.unpublish(_screenShare);
      _screenShare = null;
    }

    function shareScreen(aDOMElement, aProperties, aHandlers, aEnableAnnotation) {
      var self = this;
      var screenShareCapability = getScreenShareCapability();
      if (!Array.isArray(aHandlers)) {
        aHandlers = [aHandlers];
      }

      return screenShareCapability.then(function() {
        return new Promise(function(resolve, reject) {
          var annotationAccPack = aEnableAnnotation && getAnnotation(aDOMElement);
          startAnnotation(annotationAccPack).
            then(function() {
              _screenShare = OT.initPublisher(aDOMElement, aProperties, function(error) {
                if (error) {
                  endAnnotation(annotationAccPack);
                  reject(error);
                } else {
                  _session.publish(_screenShare, function(error) {
                    if (error) {
                      endAnnotation(annotationAccPack);
                      reject({
                        code: PUB_SCREEN_ERROR_CODES.errPublishingScreen,
                        message: error.message
                      });
                    } else {
                      setupAnnotation(annotationAccPack, _screenShare, aDOMElement);
                      resolve(_screenShare);
                    }
                  });
                }
              });
              aHandlers && _setHandlers(self, _screenShare, aHandlers);
            });
        });
      });
    }

    function setPreferredResolution(aSubscriber, aTotalDimension, aSubsDimension,
                                    aSubsNumber, aAlgorithm) {
      var PrefResolutionAlgProv = global.PreferredResolutionAlgorithmProvider;
      if (!PrefResolutionAlgProv) {
        return;
      }
      var algInfo = PrefResolutionAlgProv.getAlg(aAlgorithm);
      var chosenAlgorithm = algInfo.chosenAlgorithm;
      var algorithm = algInfo.algorithm;
      var streamDimension = aSubscriber.stream.videoDimensions;
      var newDimension =
        algorithm(streamDimension, aTotalDimension, aSubsDimension, aSubsNumber);

      if (!requestedResolutions[aSubscriber.id]) {
        // Set the initial subscriber stream resolution
        requestedResolutions[aSubscriber.id] = aSubscriber.stream.videoDimensions;
      }

      var existingResolution = requestedResolutions[aSubscriber.id];
      if (newDimension.width === existingResolution.width && newDimension.height === existingResolution.height ) {
        return; // No need to request a new resolution
      }

      logger.log('setPreferedResolution -', chosenAlgorithm, ':', aSubscriber.stream.streamId,
                 'of', aSubsNumber, ': Existing:', existingResolution, 'Requesting:', newDimension);

      requestedResolutions[aSubscriber.id] = newDimension;
      aSubscriber.setPreferredResolution(newDimension);
    }

    return {
      get session() {
        return _session;
      },
      connect: connect,
      getDevices: getDevices,
      getVideoDeviceNotInUse: getVideoDeviceNotInUse,
      initPublisher: initPublisher,
      off: off,
      otLoaded: otLoaded,
      publish: publish,
      toggleSubscribersAudio: toggleSubscribersAudio,
      toggleSubscribersVideo: toggleSubscribersVideo,
      togglePublisherAudio: togglePublisherAudio,
      togglePublisherVideo: togglePublisherVideo,
      toggleFacingMode: toggleFacingMode,
      setAudioSource: setAudioSource,
      toggleFilters: toggleFilters,
      shareScreen: shareScreen,
      subscribe: subscribe,
      stopShareScreen: stopShareScreen,
      get isPublisherReady() {
        return _publisherInitialized;
      },
      disconnect: disconnect,
      removeListener: removeListener,
      publisherHas: function(aType) {
        return _publisher.stream['has' + (aType.toLowerCase() === 'audio' && 'Audio' || 'Video')];
      },
      get publisherId() {
        return (_publisherInitialized && _publisher && _publisher.stream && _publisher.stream.id) ||
          null;
      },
      isMyself: function(connection) {
        return _session &&
          _session.connection.connectionId === connection.connectionId;
      },
      get screenShare() {
        return _screenShare;
      },
      getImg: function(stream) {
        if (!stream) {
          return null;
        }

        if (typeof stream.getImgData === 'function') {
          return stream.getImgData();
        }

        var subscribers = _session.getSubscribersForStream(stream);
        return subscribers.length ? subscribers[0].getImgData() : null;
      },
      showAnnotationToolbar: function(aShow) {
        var container = document.getElementById('annotationToolbarContainer');
        if (!container) {
          return;
        }
        (aShow && (container.classList.remove('ots-hidden') || true)) ||
          container.classList.add('ots-hidden');
      },
      setPreferredResolution: setPreferredResolution
    };
  }

  OTHelper.registerScreenShareExtension = registerScreenShareExtension;
  OTHelper.screenShareErrorCodes = PUB_SCREEN_ERROR_CODES;

  global.OTHelper = OTHelper;

}(this);
    